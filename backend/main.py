from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

import secrets
import string
import uuid
from dataclasses import dataclass, field
from typing import Dict


app = FastAPI(title="SyncWalk API")


# ---------------------------------------------------------
# CORS
# ---------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------
# Session models
# ---------------------------------------------------------

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


# In-memory sessions
sessions: Dict[str, Session] = {}


# ---------------------------------------------------------
# Join-code generation
# ---------------------------------------------------------

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


# ---------------------------------------------------------
# Health check
# ---------------------------------------------------------

@app.get("/")
async def health_check():
    return {
        "status": "ok",
        "app": "SyncWalk"
    }


# ---------------------------------------------------------
# Create session
# ---------------------------------------------------------

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


# ---------------------------------------------------------
# Join session
# ---------------------------------------------------------

@app.post("/sessions/join")
async def join_session(data: dict):

    join_code = (
        data.get("join_code", "")
        .strip()
        .upper()
    )

    if len(join_code) != 6:
        raise HTTPException(
            status_code=400,
            detail="Invalid join code."
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
            detail="Session not found."
        )

    # Count currently connected participants
    if len(session.participants) >= 2:
        raise HTTPException(
            status_code=409,
            detail="This session is full."
        )

    participant_id = str(uuid.uuid4())

    return {
        "session_id": session.id,
        "participant_id": participant_id,
    }


# ---------------------------------------------------------
# WebSocket
# ---------------------------------------------------------

@app.websocket("/ws/{session_id}/{participant_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    session_id: str,
    participant_id: str,
):

    print("🔌 WebSocket request received")
    print("   session_id:", session_id)
    print("   participant_id:", participant_id)

    session = sessions.get(session_id)

    # -----------------------------------------------------
    # Session doesn't exist
    # -----------------------------------------------------

    if session is None:

        print("❌ SESSION NOT FOUND")

        await websocket.accept()

        await websocket.send_json({
            "type": "error",
            "message": "Session not found"
        })

        await websocket.close()

        return

    print("✅ SESSION FOUND")

    # -----------------------------------------------------
    # Maximum 2 participants
    # -----------------------------------------------------

    if len(session.participants) >= 2:

        print("❌ SESSION FULL")

        await websocket.accept()

        await websocket.send_json({
            "type": "error",
            "message": "Session already has two participants"
        })

        await websocket.close()

        return

    # -----------------------------------------------------
    # Accept connection
    # -----------------------------------------------------

    await websocket.accept()

    print("✅ WebSocket accepted")

    participant = Participant(
        id=participant_id,
        websocket=websocket,
    )

    session.participants[participant_id] = participant

    print(
        "👥 Participants:",
        list(session.participants.keys())
    )

    try:

        # -------------------------------------------------
        # Tell everyone current participant count
        # -------------------------------------------------

        await broadcast(
            session,
            {
                "type": "participant_count",
                "count": len(session.participants),
            },
        )

        # -------------------------------------------------
        # Listen for messages
        # -------------------------------------------------

        while True:

            message = await websocket.receive_json()

            message_type = message.get("type")

            # ---------------------------------------------
            # Location update
            # ---------------------------------------------

            if message_type == "location":

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

        print("👋 Participant disconnected")

        session.participants.pop(
            participant_id,
            None,
        )

        # Tell remaining participant
        # that someone left

        await broadcast(
            session,
            {
                "type": "participant_left",
                "participant_id": participant_id,
            },
        )

        # Delete empty session

        if not session.participants:

            sessions.pop(
                session_id,
                None,
            )


# ---------------------------------------------------------
# Broadcast helper
# ---------------------------------------------------------

async def broadcast(
    session: Session,
    message: dict,
    exclude: str | None = None,
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