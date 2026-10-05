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

import asyncio

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
    "https://valhalla1.openstreetmap.de/route"
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
# ============================================================
# VALIDATE + NORMALIZE QWEN SPATIAL PLAN
# ============================================================

def normalize_spatial_plan(plan: dict):
    """
    Normalize the Qwen shape into:

        points = [
            [x, y],
            [x, y],
            ...
            [x, y]   # same as first point
        ]

    IMPORTANT:
    The FIRST point represents the player's actual starting location.

    The shape is translated so the first vertex becomes (0, 0).

    The last point is forced to be (0, 0), so the route closes
    back at the player's actual starting GPS position.
    """

    if not isinstance(plan, dict):
        raise ValueError("Spatial plan must be an object.")

    shape_name = plan.get("shape_name")

    if not isinstance(shape_name, str) or not shape_name.strip():
        raise ValueError("Spatial plan is missing shape_name.")

    raw_points = plan.get("points")

    if not isinstance(raw_points, list):
        raise ValueError("Spatial plan is missing points.")

    # A triangle needs at least 3 vertices.
    if not 3 <= len(raw_points) <= 30:
        raise ValueError(
            "Spatial plan must contain between 3 and 30 points."
        )

    points = []

    for point in raw_points:

        # Support:
        # [x, y]
        if isinstance(point, (list, tuple)) and len(point) == 2:
            x = point[0]
            y = point[1]

        # Also support:
        # {"x": x, "y": y}
        elif isinstance(point, dict):
            x = point.get("x")
            y = point.get("y")

        else:
            raise ValueError(
                "Each point must contain x and y."
            )

        if not isinstance(x, (int, float)):
            raise ValueError("Invalid x coordinate.")

        if not isinstance(y, (int, float)):
            raise ValueError("Invalid y coordinate.")

        if not math.isfinite(x) or not math.isfinite(y):
            raise ValueError(
                "Coordinates must be finite."
            )

        if abs(float(x)) > 100 or abs(float(y)) > 100:
            raise ValueError("Coordinates are unreasonably large.")
        points.append([
            float(x),
            float(y),
        ])

    # --------------------------------------------------------
    # FIRST QWEN POINT = START VERTEX
    # --------------------------------------------------------

    start_x, start_y = points[0]

    # Translate the entire shape so the FIRST vertex
    # becomes exactly (0, 0).
    anchored_points = [
        [
            x - start_x,
            y - start_y,
        ]
        for x, y in points
    ]

    # --------------------------------------------------------
    # REMOVE accidental duplicate consecutive points
    # --------------------------------------------------------

    cleaned = [anchored_points[0]]

    for point in anchored_points[1:]:
        previous = cleaned[-1]

        if (
            abs(point[0] - previous[0]) > 1e-9
            or abs(point[1] - previous[1]) > 1e-9
        ):
            cleaned.append(point)

    if len(cleaned) < 3:
        raise ValueError(
            "Spatial plan does not contain enough distinct vertices."
        )

    # --------------------------------------------------------
    # CLOSE THE SHAPE
    # --------------------------------------------------------

    # The last point MUST be the starting point.
    if (
        abs(cleaned[-1][0]) > 1e-9
        or abs(cleaned[-1][1]) > 1e-9
    ):
        cleaned.append([0.0, 0.0])

    normalized_plan = {
        "shape_name": shape_name.strip(),
        "title": str(plan.get("title") or "")[:60],
        "points": cleaned,
        "rotation_degrees": float(plan.get("rotation_degrees", 0)),
        "target_perimeter_m": float(plan.get("target_perimeter_m") or 0) or None,
        "budget_km": float(plan.get("budget_km") or 0) or None,
        "pace": plan.get("pace"),
        "size": plan.get("size"),
    }

    return normalized_plan


def validate_spatial_plan(plan: dict):
    """
    Validate and normalize the Qwen plan.
    """

    normalized = normalize_spatial_plan(plan)

    return normalized
# ============================================================
# ROTATE + SCALE QWEN SHAPE
# ============================================================

def transform_shape(
    points,
    target_distance_m,
    rotation_degrees,
):
    """
    Scale a normalized shape so its straight-line perimeter
    equals target_distance_m, then rotate it.

    points[0] and points[-1] are always [0, 0] (the player's start).
    """

    raw_points = [(float(p[0]), float(p[1])) for p in points]

    if len(raw_points) < 3:
        raise ValueError("Shape requires at least 3 points.")

    perimeter = 0.0
    for i in range(len(raw_points) - 1):
        x1, y1 = raw_points[i]
        x2, y2 = raw_points[i + 1]
        perimeter += math.hypot(x2 - x1, y2 - y1)

    if perimeter <= 0:
        raise ValueError("Invalid shape perimeter.")

    scale = float(target_distance_m) / perimeter

    angle = math.radians(rotation_degrees)
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)

    transformed = []
    for x, y in raw_points:
        rx = x * cos_a - y * sin_a
        ry = x * sin_a + y * cos_a
        transformed.append([rx * scale, ry * scale])

    transformed[0] = [0.0, 0.0]
    transformed[-1] = [0.0, 0.0]

    return transformed
# ============================================================
# LOCAL SHAPE -> GPS
# ============================================================

def shape_to_gps(
    local_points,
    start_lat,
    start_lon,
):
    """
    Convert local-meter coordinates into GPS.

    [0, 0] becomes EXACTLY the player's starting GPS point.
    """

    gps_points = []

    for x, y in local_points:

        gps_points.append(
            local_to_gps(
                x,
                y,
                start_lat,
                start_lon,
            )
        )

    # Absolute guarantee that the first and last
    # coordinates are the player's actual starting point.
    gps_points[0] = [
        start_lat,
        start_lon,
    ]

    gps_points[-1] = [
        start_lat,
        start_lon,
    ]

    return gps_points

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
# VALHALLA ROUTING (chunked)
#
# Replaces the old `route_through_waypoints` in main.py.
# Paste this whole block in its place. Everything else in
# main.py (generate_player_route, etc.) stays exactly the same.
#
# Why: the public Valhalla server rejects any request with more
# than 10 locations. We now split the shape into overlapping
# chunks of <= 10 points, route each chunk, and stitch the
# results together into one continuous route.
# ============================================================

# Set VALHALLA_MAX_LOCATIONS in your env if you self-host Valhalla
# with a higher limit.
MAX_VALHALLA_LOCATIONS = int(os.getenv("VALHALLA_MAX_LOCATIONS", "10"))


def chunk_waypoints(waypoints, size):
    """
    Split waypoints into overlapping chunks of at most `size` points.

    The last point of one chunk is the first point of the next, so the
    stitched route stays continuous.

    Example (size=4): [0,1,2,3,4,5,6] -> [0,1,2,3], [3,4,5,6]
    """
    chunks = []
    i = 0

    while i < len(waypoints) - 1:
        chunks.append(waypoints[i:i + size])
        i += size - 1

    return chunks


async def _route_chunk(client, chunk, costing):
    """
    Route ONE chunk (<= MAX_VALHALLA_LOCATIONS points).

    Returns (decoded_points, duration_seconds).
    """
    locations = []

    for index, point in enumerate(chunk):
        is_end = index == 0 or index == len(chunk) - 1

        locations.append({
            "lat": point[0],
            "lon": point[1],
            "type": "break" if is_end else "through",

            # Qwen vertices rarely land on a road, so give Valhalla
            # room to snap to a nearby routable street.
            "radius": 500,
        })

    payload = {
        "locations": locations,
        "costing": costing,
        "units": "kilometers",
        "shape_format": "polyline6",
        "directions_options": {"units": "kilometers"},
    }

    # The public server rate-limits; retry politely on HTTP 429.
    response = None

    for attempt in range(3):
        try:
            response = await client.post(VALHALLA_URL, json=payload)
        except Exception as error:
            raise ValueError(f"Could not connect to Valhalla: {error}")

        if response.status_code != 429:
            break

        await asyncio.sleep(1.5 * (attempt + 1))

    if response.status_code >= 400:
        try:
            error_data = response.json()
        except Exception:
            error_data = response.text

        raise ValueError(
            f"Valhalla routing failed "
            f"(HTTP {response.status_code}): {error_data}"
        )

    try:
        data = response.json()
    except Exception as error:
        raise ValueError(f"Valhalla returned invalid JSON: {error}")

    trip = data.get("trip")

    if not trip:
        raise ValueError("Valhalla returned no trip.")

    for index, location in enumerate(trip.get("locations", [])):
        if location.get("type") == "unreached":
            raise ValueError(
                f"Valhalla could not reach waypoint {index} in a chunk."
            )

    points = []

    for leg in trip.get("legs", []):
        encoded = leg.get("shape")

        if not encoded:
            continue

        decoded = decode_polyline6(encoded)

        if not decoded:
            continue

        points.extend(decoded if not points else decoded[1:])

    if len(points) < 2:
        raise ValueError("Valhalla returned an empty route for a chunk.")

    duration = float(trip.get("summary", {}).get("time", 0))

    return points, duration


async def route_through_waypoints(
    waypoints,
    travel_mode,
):
    """
    Route through the requested shape vertices.

    Qwen creates geometric vertices; Valhalla turns them into an actual
    walkable / cyclable route. Long shapes are split into chunks so no
    single request exceeds Valhalla's location limit.

    The first and last waypoint are the player's start (closed loop).
    """

    if len(waypoints) < 4:
        raise ValueError("A closed route requires at least 4 waypoints.")

    # Force exact closure.
    waypoints = [[float(p[0]), float(p[1])] for p in waypoints]
    waypoints[-1] = waypoints[0].copy()

    costing = "pedestrian" if travel_mode == "walking" else "bicycle"

    chunks = chunk_waypoints(waypoints, MAX_VALHALLA_LOCATIONS)

    print(
        f"🛣️ Routing {len(waypoints)} waypoints "
        f"in {len(chunks)} chunk(s)"
    )

    route_points = []
    duration_seconds = 0.0

    async with httpx.AsyncClient(timeout=60) as client:

        # Sequential on purpose: friendlier to the public server's
        # rate limits (both players already route concurrently).
        for number, chunk in enumerate(chunks):
            points, seconds = await _route_chunk(client, chunk, costing)

            # Skip the first point of later chunks: it duplicates the
            # last point of the previous chunk.
            route_points.extend(points if number == 0 else points[1:])
            duration_seconds += seconds

    if len(route_points) < 2:
        raise ValueError("Valhalla returned an empty route.")

    # Hard snap start / end to the player's real position.
    route_points[0] = [waypoints[0][0], waypoints[0][1]]
    route_points[-1] = [waypoints[-1][0], waypoints[-1][1]]

    distance_km = route_distance(route_points) / 1000

    return {
        "points": route_points,
        "distance_km": round(distance_km, 3),
        "duration_minutes": round(duration_seconds / 60, 1),
    }
# ============================================================
# GENERATE ONE PLAYER ROUTE
async def generate_player_route(
    start_location,
    spatial_plan,
    travel_mode,
    max_distance_km,
):
    """
    Generate a closed route for ONE player.

    The player's start is vertex 0 of the shape.
    """

    limit_km = (
        spatial_plan.get("budget_km")
        or max_distance_km
    )

    target_m = (
        spatial_plan.get("target_perimeter_m")
        or (limit_km * 1000 / 1.4)
    )

    base_points = transform_shape(
        spatial_plan["points"],
        target_m,
        spatial_plan.get(
            "rotation_degrees",
            0
        ),
    )

    scale_factors = [
        1.0,
        0.85,
        0.70,
        0.55,
        0.40,
    ]

    last_routed = None
    last_waypoints = None
    errors = []

    for factor in scale_factors:

        scaled_points = [
            [
                x * factor,
                y * factor
            ]
            for x, y in base_points
        ]

        # Always force exact closure.
        scaled_points[0] = [
            0.0,
            0.0
        ]

        scaled_points[-1] = [
            0.0,
            0.0
        ]

        waypoints = shape_to_gps(
            scaled_points,
            start_location["lat"],
            start_location["lng"],
        )

        print(
            f"🔄 Routing attempt "
            f"factor={factor}"
        )

        try:

            routed = await route_through_waypoints(
                waypoints,
                travel_mode
            )

            last_routed = routed
            last_waypoints = waypoints

            print(
                f"🛣️ Route generated: "
                f"{routed['distance_km']} km "
                f"(limit {limit_km} km)"
            )

            # Successful route within limit.
            if (
                routed["distance_km"]
                <= limit_km
            ):
                return {
                    **routed,
                    "waypoints": waypoints,
                }

            print(
                "⚠️ Route exceeds distance limit."
            )

        except Exception as error:

            error_message = str(error)

            errors.append(
                f"factor={factor}: "
                f"{error_message}"
            )

            print(
                f"⚠️ Routing attempt "
                f"{factor} failed:"
            )
            print(
                error_message
            )

    # --------------------------------------------------------
    # NOTHING WORKED
    # --------------------------------------------------------

    if last_routed is None:

        details = "\n".join(
            errors
        )

        raise ValueError(
            "Valhalla could not create a route "
            "for this shape.\n"
            f"Attempts:\n{details}"
        )

    # --------------------------------------------------------
    # A ROUTE EXISTED BUT EXCEEDED THE LIMIT
    # --------------------------------------------------------

    return {
        **last_routed,
        "waypoints": last_waypoints,
        "warning": (
            "Route may exceed the requested "
            "maximum distance."
        ),}
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
    """
    Generate Player A and Player B routes concurrently.

    Both players use the SAME shape.

    Their actual GPS locations are different, so the same
    geometry is anchored independently at each player's
    starting point.
    """

    normalized_plan = validate_spatial_plan(spatial_plan)
    print(
        "🧠 Spatial plan:",
        normalized_plan
    )

    # --------------------------------------------------------
    # Generate BOTH routes at the same time
    # --------------------------------------------------------

    player_a_task = generate_player_route(
        start_location=player_a,
        spatial_plan=normalized_plan,
        travel_mode=travel_mode,
        max_distance_km=max_distance_km,
    )

    player_b_task = generate_player_route(
        start_location=player_b,
        spatial_plan=normalized_plan,
        travel_mode=travel_mode,
        max_distance_km=max_distance_km,
    )

    player_a_route, player_b_route = await asyncio.gather(
        player_a_task,
        player_b_task,
    )

    print("✅ Player A route ready")
    print("✅ Player B route ready")

    return {
        "prompt": prompt,

        "travel_mode": travel_mode,

        "max_distance_km": max_distance_km,

        "spatial_plan": normalized_plan,

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
        "app": "GetOut!",
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

    print("🆕 SESSION CREATED")
    print("   Session ID:", session_id)
    print("   Join code:", join_code)
    print("   Active sessions:", [
        s.join_code for s in sessions.values()
    ])

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

    print("🔎 Join attempt:", join_code)
    print(
        "📦 Active sessions:",
        [session.join_code for session in sessions.values()]
    )
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
                            "message": (
                                "Both players must be connected."
                            )
                        })
                        continue

                    # ------------------------------------------------
                    # Player locations
                    # ------------------------------------------------

                    player_locations = message.get(
                        "players"
                    )

                    if (
                        not isinstance(
                            player_locations,
                            list
                        )
                        or len(player_locations) != 2
                    ):
                        await websocket.send_json({
                            "type": "error",
                            "message": (
                                "Two player locations are required."
                            )
                        })
                        continue

                    player_a = player_locations[0]
                    player_b = player_locations[1]

                    # ------------------------------------------------
                    # Spatial plan generated by LOCAL QWEN
                    # ------------------------------------------------

                    spatial_plan = message.get(
                        "spatial_plan"
                    )

                    if not isinstance(
                        spatial_plan,
                        dict
                    ):
                        await websocket.send_json({
                            "type": "error",
                            "message": (
                                "A valid spatial plan is required."
                            )
                        })
                        continue

                    # ------------------------------------------------
                    # Challenge settings
                    # ------------------------------------------------

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
                        "🚀 Generating BOTH player routes..."
                    )

                    # ------------------------------------------------
                    # Generate both routes concurrently
                    # ------------------------------------------------

                    result = await generate_game_routes(
                        prompt=prompt,
                        travel_mode=travel_mode,
                        max_distance_km=max_distance_km,
                        player_a=player_a,
                        player_b=player_b,
                        spatial_plan=spatial_plan,
                    )

                    print(
                        "🎉 BOTH routes generated."
                    )

                    # ------------------------------------------------
                    # Send BOTH routes to BOTH players
                    # ------------------------------------------------

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