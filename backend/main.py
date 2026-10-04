from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

import secrets
import string
import uuid
import json
import math
import os
import re
import httpx
from dataclasses import dataclass, field
from typing import Dict, Optional


app = FastAPI(title="GetOut!")


# -------------------------------------------------------
# CORS
# -------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "https://get-out-nine.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# AI + ROUTING CONFIG
# ============================================================


VALHALLA_URL = os.getenv(
    "VALHALLA_URL",
    "https://valhalla.openstreetmap.de/route"
)


# ============================================================
# GEOGRAPHIC HELPERS
# ============================================================

EARTH_RADIUS_M = 6371000


def haversine_distance(a, b):
    """
    Distance between two [lat, lon] points in meters.
    """

    lat1, lon1 = a
    lat2, lon2 = b

    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)

    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)

    value = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1)
        * math.cos(phi2)
        * math.sin(d_lambda / 2) ** 2
    )

    return 2 * EARTH_RADIUS_M * math.asin(
        math.sqrt(value)
    )


def route_distance(points):
    """
    Total distance of a [lat, lon] route in meters.
    """

    if len(points) < 2:
        return 0

    return sum(
        haversine_distance(points[i], points[i + 1])
        for i in range(len(points) - 1)
    )


# ============================================================
# LAT/LON <-> LOCAL 2D COORDINATES
# ============================================================

def gps_to_local(lat, lon, origin_lat, origin_lon):
    """
    Convert GPS coordinates into local Cartesian meters.

    x = east/west
    y = north/south
    """

    lat_scale = 111320

    lon_scale = (
        111320
        * math.cos(math.radians(origin_lat))
    )

    x = (lon - origin_lon) * lon_scale
    y = (lat - origin_lat) * lat_scale

    return x, y


def local_to_gps(x, y, origin_lat, origin_lon):
    """
    Convert local Cartesian meters back to GPS.
    """

    lat_scale = 111320

    lon_scale = (
        111320
        * math.cos(math.radians(origin_lat))
    )

    lat = origin_lat + (y / lat_scale)

    lon = origin_lon + (x / lon_scale)

    return [lat, lon]


# ============================================================
# RELATIVE PLAYER POSITIONS
# ============================================================

def calculate_player_context(player_a, player_b):
    """
    Put both players into the same local coordinate system.

    This information is given to Qwen.

    Qwen sees:

        Player A = (x1, y1)
        Player B = (x2, y2)

    but does NOT receive raw street-routing instructions.
    """

    mid_lat = (
        player_a["lat"]
        + player_b["lat"]
    ) / 2

    mid_lon = (
        player_a["lng"]
        + player_b["lng"]
    ) / 2

    ax, ay = gps_to_local(
        player_a["lat"],
        player_a["lng"],
        mid_lat,
        mid_lon,
    )

    bx, by = gps_to_local(
        player_b["lat"],
        player_b["lng"],
        mid_lat,
        mid_lon,
    )

    separation = math.sqrt(
        (bx - ax) ** 2
        + (by - ay) ** 2
    )

    return {
        "origin": {
            "lat": mid_lat,
            "lon": mid_lon,
        },
        "player_a": {
            "x_m": round(ax, 2),
            "y_m": round(ay, 2),
        },
        "player_b": {
            "x_m": round(bx, 2),
            "y_m": round(by, 2),
        },
        "separation_m": round(
            separation,
            2,
        ),
    }


# ============================================================
# QWEN JSON EXTRACTION
# ============================================================

def extract_json(text):
    """
    Qwen may occasionally wrap JSON in markdown
    or include additional text.

    Extract the first JSON object.
    """

    text = text.strip()

    # Remove markdown fences.
    text = re.sub(
        r"```json\s*",
        "",
        text,
        flags=re.IGNORECASE,
    )

    text = re.sub(
        r"```\s*$",
        "",
        text,
    )

    # Find JSON object.
    match = re.search(
        r"\{.*\}",
        text,
        re.DOTALL,
    )

    if not match:
        raise ValueError(
            "Qwen did not return valid JSON."
        )

    return json.loads(
        match.group(0)
    )


# ============================================================
# VALIDATE QWEN PLAN
# ============================================================

def validate_spatial_plan(plan: dict):
    if not isinstance(plan, dict):
        raise ValueError("Spatial plan must be an object.")

    shape_name = plan.get("shape_name")

    if not isinstance(shape_name, str) or not shape_name.strip():
        raise ValueError("Spatial plan is missing shape_name.")

    points = plan.get("points")

    if not isinstance(points, list):
        raise ValueError("Spatial plan is missing points.")

    if not 6 <= len(points) <= 30:
        raise ValueError(
            "Spatial plan must contain between 6 and 30 points."
        )

    for point in points:
        if (
            not isinstance(point, (list, tuple))
            or len(point) != 2
        ):
            raise ValueError("Each point must contain x and y.")

        x, y = point

        if not isinstance(x, (int, float)):
            raise ValueError("Invalid x coordinate.")

        if not isinstance(y, (int, float)):
            raise ValueError("Invalid y coordinate.")

        if not math.isfinite(x) or not math.isfinite(y):
            raise ValueError("Coordinates must be finite.")

        if not -1.0 <= x <= 1.0:
            raise ValueError("x must be between -1 and 1.")

        if not -1.0 <= y <= 1.0:
            raise ValueError("y must be between -1 and 1.")

    rotation = plan.get("rotation_degrees", 0)

    if not isinstance(rotation, (int, float)):
        raise ValueError("Invalid rotation.")

    return True

# ============================================================
# ROTATE + SCALE QWEN SHAPE
# ============================================================

def transform_shape(
    points,
    max_distance_km,
    rotation_degrees,
):
    """
    Convert Qwen's normalized shape into
    a real-world local-meter shape.

    We intentionally use only a fraction of the
    maximum allowed distance because road routing
    can make the final route longer.
    """

    raw_points = [
        (
            float(point["x"]),
            float(point["y"]),
        )
        for point in points
    ]

    # --------------------------------------------------------
    # Calculate normalized perimeter.
    # --------------------------------------------------------

    perimeter = 0

    for i in range(len(raw_points) - 1):

        x1, y1 = raw_points[i]
        x2, y2 = raw_points[i + 1]

        perimeter += math.sqrt(
            (x2 - x1) ** 2
            +
            (y2 - y1) ** 2
        )

    if perimeter <= 0:
        raise ValueError(
            "Invalid Qwen shape perimeter."
        )

    # --------------------------------------------------------
    # Use roughly 55% of requested distance.
    # This gives Valhalla room to route around
    # actual streets.
    # --------------------------------------------------------

    target_distance_m = (
        max_distance_km
        * 1000
        * 0.55
    )

    scale = (
        target_distance_m
        / perimeter
    )

    angle = math.radians(
        rotation_degrees
    )

    cos_a = math.cos(angle)
    sin_a = math.sin(angle)

    transformed = []

    for x, y in raw_points:

        # Rotate.
        rx = (
            x * cos_a
            - y * sin_a
        )

        ry = (
            x * sin_a
            + y * cos_a
        )

        # Scale.
        transformed.append([
            rx * scale,
            ry * scale,
        ])

    return transformed


# ============================================================
# LOCAL SHAPE -> GPS
# ============================================================

def shape_to_gps(
    local_points,
    start_lat,
    start_lon,
):
    return [
        local_to_gps(
            x,
            y,
            start_lat,
            start_lon,
        )
        for x, y in local_points
    ]


# ============================================================
# VALHALLA POLYLINE6 DECODER
# ============================================================

def decode_polyline6(encoded):
    """
    Decode Valhalla's polyline6 format.

    Valhalla uses six decimal places for its
    encoded route shapes.
    """

    coordinates = []

    index = 0
    lat = 0
    lon = 0

    factor = 1000000

    while index < len(encoded):

        result = 0
        shift = 0

        while True:
            byte = ord(
                encoded[index]
            ) - 63

            index += 1

            result |= (
                (byte & 0x1F)
                << shift
            )

            shift += 5

            if byte < 0x20:
                break

        delta_lat = (
            ~(result >> 1)
            if result & 1
            else result >> 1
        )

        lat += delta_lat

        result = 0
        shift = 0

        while True:
            byte = ord(
                encoded[index]
            ) - 63

            index += 1

            result |= (
                (byte & 0x1F)
                << shift
            )

            shift += 5

            if byte < 0x20:
                break

        delta_lon = (
            ~(result >> 1)
            if result & 1
            else result >> 1
        )

        lon += delta_lon

        coordinates.append([
            lat / factor,
            lon / factor,
        ])

    return coordinates


# ============================================================
# VALHALLA ROUTING
# ============================================================

async def route_through_waypoints(
    waypoints,
    travel_mode,
):
    """
    Route through the AI-generated waypoints.

    Valhalla handles the actual road network.
    """

    costing = (
        "pedestrian"
        if travel_mode == "walking"
        else "bicycle"
    )

    locations = [
        {
            "lat": point[0],
            "lon": point[1],
          }
        for point in waypoints
    ]

    payload = {
        "locations": locations,

        "costing": costing,

        "units": "kilometers",

        "shape_format": "polyline6",
    }

    async with httpx.AsyncClient(
        timeout=90
    ) as client:
        response = await client.post(
            VALHALLA_URL,
            json=payload,
        )

        response.raise_for_status()

        data = response.json()

    trip = data.get("trip")

    if not trip:
        raise ValueError(
            "Valhalla did not return a trip."
        )

    route_points = []

    for leg in trip.get("legs", []):

        encoded_shape = leg.get(
            "shape"
        )

        if not encoded_shape:
            continue

        decoded = decode_polyline6(
            encoded_shape
        )

        if route_points:
            # Avoid duplicate point between legs.
            route_points.extend(
                decoded[1:]
            )
        else:
            route_points.extend(
                decoded
            )

    if len(route_points) < 2:
        raise ValueError(
            "Valhalla returned an empty route."
        )

    return {
        "points": route_points,

        "distance_km": round(
            route_distance(route_points)
            / 1000,
            3,
        ),

        "duration_minutes": round(
            trip["summary"]["time"]
            / 60,
            1,
        ),
    }


# ============================================================
# GENERATE ONE PLAYER ROUTE
# ============================================================

async def generate_player_route(
    start_location,
    spatial_plan,
    travel_mode,
    max_distance_km,
):
    base_points = transform_shape(
        spatial_plan["points"],
        max_distance_km,
        spatial_plan.get("rotation_degrees", 0),
    )

    scale_factors = [1.0, 0.8, 0.65]

    last_routed = None
    last_waypoints = None

    for factor in scale_factors:
        scaled_points = [
            [x * factor, y * factor]
            for x, y in base_points
        ]

        waypoints = shape_to_gps(
            scaled_points,
            start_location["lat"],
            start_location["lng"],
        )

        waypoints[-1] = waypoints[0]

        try:
            routed = await route_through_waypoints(
                waypoints,
                travel_mode,
            )

            last_routed = routed
            last_waypoints = waypoints

            if routed["distance_km"] <= max_distance_km:
                return {
                    **routed,
                    "waypoints": waypoints,
                }

        except Exception as error:
            print(
                "Routing attempt failed:",
                repr(error),
            )

    if last_routed is None:
        raise ValueError(
            "Valhalla could not create a route "
            "for this shape."
        )

    return {
        **last_routed,
        "waypoints": last_waypoints,
        "warning": (
            "Route may exceed the requested "
            "maximum distance."
        ),
    }

# ============================================================
# GENERATE BOTH PLAYER ROUTES
# ============================================================

async def generate_game_routes(
    prompt,
    travel_mode,
    max_distance_km,
    player_a,
    player_b,
    spatial_plan,
):
    validate_spatial_plan(spatial_plan)

    player_a_route = await generate_player_route(
        player=player_a,
        spatial_plan=spatial_plan,
        travel_mode=travel_mode,
        max_distance_km=max_distance_km,
    )

    player_b_route = await generate_player_route(
        player=player_b,
        spatial_plan=spatial_plan,
        travel_mode=travel_mode,
        max_distance_km=max_distance_km,
    )

    return {
        "prompt": prompt,
        "travel_mode": travel_mode,
        "max_distance_km": max_distance_km,
        "spatial_plan": spatial_plan,
        "player_a": player_a_route,
        "player_b": player_b_route,
    }
# -------------------------------------------------------
# Data models
# -------------------------------------------------------

@dataclass
class Participant:
    id: str
    websocket: WebSocket


@dataclass
class Session:
    id: str
    join_code: str

    participants: Dict[str, Participant] = field(
        default_factory=dict
    )

    # Challenge created by the creator
    challenge: Optional[dict] = None

    # Whether the challenge has started
    started: bool = False


sessions: Dict[str, Session] = {}


# -------------------------------------------------------
# Join code
# -------------------------------------------------------

ALPHABET = string.ascii_uppercase + string.digits


def generate_join_code(length: int = 6) -> str:
    return "".join(
        secrets.choice(ALPHABET)
        for _ in range(length)
    )


def create_unique_code() -> str:
    while True:
        code = generate_join_code()

        if not any(
            session.join_code == code
            for session in sessions.values()
        ):
            return code


# -------------------------------------------------------
# Health check
# -------------------------------------------------------

@app.get("/")
async def health_check():
    return {
        "status": "ok",
        "app": "SyncWalk",
    }


# -------------------------------------------------------
# Create session
# -------------------------------------------------------

@app.post("/sessions")
async def create_session():

    session_id = str(uuid.uuid4())

    join_code = create_unique_code()

    session = Session(
        id=session_id,
        join_code=join_code,
    )

    sessions[session_id] = session

    return {
        "session_id": session_id,
        "join_code": join_code,
    }


# -------------------------------------------------------
# Join session
# -------------------------------------------------------

@app.post("/sessions/join")
async def join_session(data: dict):

    join_code = data.get(
        "join_code",
        ""
    ).strip().upper()

    if len(join_code) != 6:
        raise HTTPException(
            status_code=400,
            detail="Invalid join code.",
        )

    session = next(
        (
            session
            for session in sessions.values()
            if secrets.compare_digest(
                session.join_code,
                join_code,
            )
        ),
        None,
    )

    if session is None:
        raise HTTPException(
            status_code=404,
            detail="Session not found.",
        )

    if len(session.participants) >= 2:
        raise HTTPException(
            status_code=409,
            detail="This session is full.",
        )

    participant_id = str(uuid.uuid4())

    return {
        "session_id": session.id,
        "participant_id": participant_id,
        "challenge": session.challenge,
        "started": session.started,
    }


# -------------------------------------------------------
# Broadcast
# -------------------------------------------------------

async def broadcast(
    session: Session,
    message: dict,
    exclude: Optional[str] = None,
):

    for participant_id, participant in list(
        session.participants.items()
    ):

        if participant_id == exclude:
            continue

        try:
            await participant.websocket.send_json(
                message
            )

        except Exception:
            session.participants.pop(
                participant_id,
                None,
            )


# -------------------------------------------------------
# WebSocket
# -------------------------------------------------------

@app.websocket(
    "/ws/{session_id}/{participant_id}"
)
async def websocket_endpoint(
    websocket: WebSocket,
    session_id: str,
    participant_id: str,
):

    session = sessions.get(session_id)

    # ---------------------------------------------------
    # Validate session
    # ---------------------------------------------------

    if session is None:

        await websocket.accept()

        await websocket.send_json({
            "type": "error",
            "message": "Session not found.",
        })

        await websocket.close()

        return

    # ---------------------------------------------------
    # Validate participant count
    # ---------------------------------------------------

    if (
        participant_id not in session.participants
        and len(session.participants) >= 2
    ):

        await websocket.accept()

        await websocket.send_json({
            "type": "error",
            "message": "Session already has two participants.",
        })

        await websocket.close()

        return

    # ---------------------------------------------------
    # Connect
    # ---------------------------------------------------

    await websocket.accept()

    participant = Participant(
        id=participant_id,
        websocket=websocket,
    )

    session.participants[participant_id] = participant

    # ---------------------------------------------------
    # Send current session state to newly connected user
    # ---------------------------------------------------

    await websocket.send_json({
        "type": "session_state",
        "challenge": session.challenge,
        "started": session.started,
        "participant_count": len(
            session.participants
        ),
    })

    # ---------------------------------------------------
    # Tell everyone about participant count
    # ---------------------------------------------------

    await broadcast(
        session,
        {
            "type": "participant_count",
            "count": len(
                session.participants
            ),
        },
    )

    try:

        while True:

            message = await websocket.receive_json()
            print(f"📨 Received from {participant_id}: {message}")
            message_type = message.get(
                "type"
            )

            # ------------------------------------------------
            # Challenge created
            # ------------------------------------------------

            if message_type == "challenge_created":

                challenge = message.get(
                    "challenge"
                )

                if not isinstance(
                    challenge,
                    dict,
                ):
                    continue

                session.challenge = challenge
                session.started = False

                await broadcast(
                    session,
                    {
                        "type": "challenge_created",
                        "challenge": challenge,
                    },
                )

            # ------------------------------------------------
            # Challenge started
            # ------------------------------------------------

            elif message_type == "start_challenge":

                if session.challenge is None:
                    await websocket.send_json({
                        "type": "error",
                        "message": (
                            "Create a challenge first."
                        ),
                    })
                    continue

                if len(session.participants) < 2:
                    await websocket.send_json({
                        "type": "error",
                        "message": (
                            "Waiting for your friend to join."
                        ),
                    })
                    continue

                session.started = True

                await broadcast(
                    session,
                    {
                        "type": "challenge_started",
                        "challenge": session.challenge,
                    },
                )
            #generate rote
            elif message_type == "generate_route":
                try:
                    challenge = session.challenge

                    if challenge is None:
                        await websocket.send_json({
                            "type": "error",
                            "message": "No challenge exists."
                        })
                        continue

                    if len(session.participants) < 2:
                        await websocket.send_json({
                            "type": "error",
                            "message": "Both players must be connected."
                        })
                        continue

                    player_locations = message.get(
                        "players"
                    )

                    if not isinstance(
                        player_locations,
                        list
                    ) or len(player_locations) != 2:

                        await websocket.send_json({
                            "type": "error",
                            "message": "Two player locations are required."
                        })

                        continue

                    player_a = player_locations[0]
                    player_b = player_locations[1]

                    prompt = challenge.get(
                        "prompt",
                        ""
                    )

                    travel_mode = challenge.get(
                        "mode",
                        "walking"
                    )

                    max_distance_km = float(
                        challenge.get(
                            "maxDistanceKm",
                            5
                        )
                    )

                    print(
                        "🚀 Generating AI route..."
                    )

                    result = await generate_game_routes(
                        prompt=prompt,
                        travel_mode=travel_mode,
                        max_distance_km=max_distance_km,
                        player_a=player_a,
                        player_b=player_b,
                    )

                    await broadcast(
                        session,
                        {
                            "type": "route_created",
                            "route": result,
                        },
                    )

                except Exception as error:

                    print(
                        "❌ Route generation error:",
                        repr(error),
                    )

                    await websocket.send_json({
                        "type": "error",
                        "message": (
                            "Could not generate the route: "
                            + str(error)
                        ),
                    })
            # ------------------------------------------------
            # Location
            # ------------------------------------------------

            elif message_type == "location":

                location = {
                    "type": "location",
                    "participant_id": participant_id,
                    "lat": message.get("lat"),
                    "lng": message.get("lng"),
                    "accuracy": message.get("accuracy"),
                }

                await broadcast(
                    session,
                    location,
                    exclude=participant_id,
                )

    except WebSocketDisconnect:

        session.participants.pop(
            participant_id,
            None,
        )

        await broadcast(
            session,
            {
                "type": "participant_left",
                "participant_id": participant_id,
            },
        )

        if not session.participants:
            sessions.pop(
                session_id,
                None,
            )