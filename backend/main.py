from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

import secrets
import string
import uuid

from dataclasses import dataclass, field
from typing import Dict, Optional


app = FastAPI(title="SyncWalk API")


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