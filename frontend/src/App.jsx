import { useEffect, useRef, useState } from "react";

import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  CircleMarker,
  useMap,
} from "react-leaflet";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";
import { generateSpatialPlanWithQwen } from "./qwen";

// ==================================================
// LEAFLET ICONS
// ==================================================

delete L.Icon.Default.prototype._getIconUrl;

L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

// ==================================================
// CONFIG
// ==================================================

const API_URL = import.meta.env.VITE_API_URL;
const WS_URL = API_URL.replace(/^http/, "ws");

const CHECKPOINT_RADIUS_METERS = 50;

// For now we are only implementing Individual Mode.
const GAME_MODE = "individual";

// ==================================================
// DISTANCE HELPER
// ==================================================

const getDistanceMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371000;

  const toRad = (value) => (value * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ==================================================
// CHECKPOINT TIME FORMATTER
// ==================================================

const formatCheckpointTime = (seconds) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);

  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(
    2,
    "0"
  )}`;
};

// ==================================================
// CHECKPOINT LABEL
// ==================================================

const getCheckpointLabel = (index, total) => {
  if (index === total - 1) {
    return "FINISH";
  }

  return `CHECKPOINT ${String.fromCharCode(64 + index)}`;
};

// ==================================================
// MAP CONTROLLER
// ==================================================

function MapController({ myLocation, friendLocation }) {
  const map = useMap();
  const hasCentered = useRef(false);

  useEffect(() => {
    if (hasCentered.current) return;

    const location = myLocation || friendLocation;

    if (!location) return;

    map.flyTo([location.lat, location.lng], 16, {
      duration: 1.2,
    });

    hasCentered.current = true;
  }, [myLocation, friendLocation, map]);

  return null;
}

// ==================================================
// TIME FORMATTER
// ==================================================

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");

  const seconds = (totalSeconds % 60)
    .toString()
    .padStart(2, "0");

  return `${minutes}:${seconds}`;
}

// ==================================================
// APP
// ==================================================

function App() {
  // ==================================================
  // SESSION STATE
  // ==================================================

  const [screen, setScreen] = useState("home");

  const [isCreator, setIsCreator] = useState(false);

  const [joinCode, setJoinCode] = useState("");

  const [sessionCode, setSessionCode] = useState("");

  const [sessionId, setSessionId] = useState("");

  const [participantId, setParticipantId] = useState("");

  const [participantCount, setParticipantCount] = useState(0);

  const [myLocation, setMyLocation] = useState(null);

  const [friendLocation, setFriendLocation] = useState(null);

  const [error, setError] = useState("");

  // ==================================================
  // CHALLENGE STATE
  // ==================================================

  const [challengePrompt, setChallengePrompt] = useState("");

  const [travelMode, setTravelMode] = useState("walking");

  const [maxDistance, setMaxDistance] = useState(5);

  const [maxTime, setMaxTime] = useState(30);

  const [challenge, setChallenge] = useState(null);

  // ==================================================
  // CHECKPOINT STATE
  // ==================================================

  const [checkpointState, setCheckpointState] = useState({
    activeIndex: 1,
    completed: {},
    times: {},
    finished: false,
  });

  const [distanceToCheckpoint, setDistanceToCheckpoint] =
    useState(null);

  // ==================================================
  // INDIVIDUAL MODE STATE
  // ==================================================

  const [myPath, setMyPath] = useState([]);

  const [friendPath, setFriendPath] = useState([]);

  const [myStartLocation, setMyStartLocation] = useState(null);

  const [friendStartLocation, setFriendStartLocation] =
    useState(null);

  const [challengeStartedAt, setChallengeStartedAt] =
    useState(null);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // ==================================================
  // ROUTE STATE
  // ==================================================

  const socketRef = useRef(null);

  const watchIdRef = useRef(null);

  const pendingChallengeRef = useRef(null);

  const [plannedRoute, setPlannedRoute] = useState(null);

  const routeRequestedRef = useRef(false);

  const [routeGenerating, setRouteGenerating] = useState(false);

  const [routesReady, setRoutesReady] = useState(false);

  const [routeAttempt, setRouteAttempt] = useState(0);

  // ==================================================
  // CHECKPOINT DERIVED DATA
  // IMPORTANT: INSIDE APP()
  // ==================================================

  const myRoute = isCreator
    ? plannedRoute?.player_a
    : plannedRoute?.player_b;

  const checkpointWaypoints = myRoute?.waypoints || [];

  const activeCheckpoint =
    checkpointWaypoints[checkpointState.activeIndex] || null;

  let isNearCheckpoint = false;

  if (myLocation && activeCheckpoint) {
    const [checkpointLat, checkpointLng] = activeCheckpoint;

    const distance = getDistanceMeters(
      myLocation.lat,
      myLocation.lng,
      checkpointLat,
      checkpointLng
    );

    isNearCheckpoint =
      distance <= CHECKPOINT_RADIUS_METERS;
  }

  // ==================================================
  // CHECKPOINT CHECK-IN
  // ==================================================

  const handleCheckpointCheckIn = () => {
    if (
      !myLocation ||
      !activeCheckpoint ||
      !challengeStartedAt
    ) {
      return;
    }

    const [checkpointLat, checkpointLng] =
      activeCheckpoint;

    const distance = getDistanceMeters(
      myLocation.lat,
      myLocation.lng,
      checkpointLat,
      checkpointLng
    );

    // Don't allow check-in unless nearby.
    if (distance > CHECKPOINT_RADIUS_METERS) {
      return;
    }

    const elapsed = Math.floor(
      (Date.now() - challengeStartedAt) / 1000
    );

    const currentIndex =
      checkpointState.activeIndex;

    setCheckpointState((prev) => ({
      ...prev,

      completed: {
        ...prev.completed,
        [currentIndex]: true,
      },

      times: {
        ...prev.times,
        [currentIndex]: elapsed,
      },

      activeIndex:
        currentIndex <
          checkpointWaypoints.length - 1
          ? currentIndex + 1
          : currentIndex,

      finished:
        currentIndex ===
        checkpointWaypoints.length - 1,
    }));
  };

  // ==================================================
  // TIMER
  // ==================================================

  useEffect(() => {
    if (!challengeStartedAt) {
      return;
    }

    const timer = setInterval(() => {
      const elapsed = Math.floor(
        (Date.now() - challengeStartedAt) / 1000
      );

      setElapsedSeconds(elapsed);
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [challengeStartedAt]);

  // ==================================================
  // CHECKPOINT DISTANCE
  // IMPORTANT: TOP-LEVEL HOOK
  // NOT INSIDE ANOTHER EFFECT
  // ==================================================

  useEffect(() => {
    if (!myLocation || !activeCheckpoint) {
      setDistanceToCheckpoint(null);
      return;
    }

    const [checkpointLat, checkpointLng] =
      activeCheckpoint;

    const distance = getDistanceMeters(
      myLocation.lat,
      myLocation.lng,
      checkpointLat,
      checkpointLng
    );

    setDistanceToCheckpoint(Math.round(distance));
  }, [myLocation, activeCheckpoint]);

  // ==================================================
  // RESET CHALLENGE
  // ==================================================

  function resetChallengeTracking() {
    setMyPath([]);
    setFriendPath([]);

    setMyLocation(null);
    setFriendLocation(null);

    setMyStartLocation(null);
    setFriendStartLocation(null);

    setChallengeStartedAt(null);
    setElapsedSeconds(0);

    setPlannedRoute(null);
    setRoutesReady(false);
    setRouteGenerating(false);

    // Reset checkpoints
    setCheckpointState({
      activeIndex: 1,
      completed: {},
      times: {},
      finished: false,
    });

    setDistanceToCheckpoint(null);

    routeRequestedRef.current = false;
  }

  // ==================================================
  // BEGIN CHALLENGE
  // ==================================================

  function beginChallenge(challengeData) {
    setChallenge(challengeData);

    resetChallengeTracking();

    startLocationTracking();

    setScreen("session");

    // Timer intentionally does NOT start here.
    // It starts when route_created is received.
  }

  // ==================================================
  // CREATE SESSION
  // ==================================================

  async function createSession() {
    try {
      setError("");

      const response = await fetch(
        `${API_URL}/sessions`,
        {
          method: "POST",
        }
      );

      if (!response.ok) {
        throw new Error(
          "Could not create session."
        );
      }

      const data = await response.json();

      const newParticipantId =
        crypto.randomUUID();

      setSessionId(data.session_id);
      setSessionCode(data.join_code);
      setParticipantId(newParticipantId);

      setIsCreator(true);
      setScreen("waiting");
    } catch (err) {
      console.error(err);

      setError(
        "Could not create session."
      );
    }
  }

  // ==================================================
  // JOIN SESSION
  // ==================================================

  async function joinSession() {
    if (sessionId) {
      return;
    }

    try {
      setError("");

      console.log(
        "JOIN CODE INPUT:",
        joinCode
      );

      const cleanCode =
        joinCode.trim().toUpperCase();

      if (cleanCode.length !== 6) {
        setError(
          "Enter a valid 6-character join code."
        );

        return;
      }

      console.log(
        "🔑 Joining with code:",
        cleanCode
      );

      const response = await fetch(
        `${API_URL}/sessions/join`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            join_code: cleanCode,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.detail ||
          "Could not join session."
        );
      }

      setSessionId(data.session_id);

      setParticipantId(
        data.participant_id
      );

      setSessionCode(cleanCode);

      setIsCreator(false);

      if (data.challenge) {
        setChallenge(data.challenge);
      }

      setScreen("waiting");
    } catch (err) {
      console.error(err);

      setError(
        err.message ||
        "Could not join session."
      );
    }
  }

  // ==================================================
  // START LOCATION TRACKING
  // ==================================================

  function startLocationTracking() {
    if (!navigator.geolocation) {
      setError(
        "Geolocation is not supported by this browser."
      );

      return;
    }

    if (watchIdRef.current !== null) {
      return;
    }

    watchIdRef.current =
      navigator.geolocation.watchPosition(
        (position) => {
          const location = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy:
              position.coords.accuracy,
          };

          // ------------------------------------------
          // MY CURRENT LOCATION
          // ------------------------------------------

          setMyLocation(location);

          // ------------------------------------------
          // MY START LOCATION
          // ------------------------------------------

          setMyStartLocation(
            (currentStart) => {
              if (currentStart) {
                return currentStart;
              }

              return location;
            }
          );

          // ------------------------------------------
          // ADD TO MY PATH
          // ------------------------------------------

          setMyPath(
            (currentPath) => [
              ...currentPath,
              [
                location.lat,
                location.lng,
              ],
            ]
          );

          // ------------------------------------------
          // SEND LOCATION TO FRIEND
          // ------------------------------------------

          if (
            socketRef.current &&
            socketRef.current.readyState ===
            WebSocket.OPEN
          ) {
            socketRef.current.send(
              JSON.stringify({
                type: "location",

                lat: location.lat,

                lng: location.lng,

                accuracy:
                  location.accuracy,
              })
            );
          }
        },

        (geoError) => {
          console.error(
            "Geolocation error:",
            geoError
          );

          if (geoError.code === 1) {
            setError(
              "Location permission was denied. Please allow location access."
            );
          } else {
            setError(
              "Could not get your current location."
            );
          }
        },

        {
          enableHighAccuracy: true,
          maximumAge: 5000,
          timeout: 10000,
        }
      );
  }

  // ==================================================
  // STOP LOCATION TRACKING
  // ==================================================

  function stopLocationTracking() {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(
        watchIdRef.current
      );

      watchIdRef.current = null;
    }
  }

  // ==================================================
  // ROUTE GENERATION
  //
  // QWEN RUNS LOCALLY IN CREATOR'S BROWSER.
  // FASTAPI ONLY RECEIVES THE SPATIAL PLAN.
  // ==================================================

  useEffect(() => {
    if (screen !== "session") {
      return;
    }

    if (!isCreator) {
      return;
    }

    if (!myLocation || !friendLocation) {
      return;
    }

    if (!challenge) {
      return;
    }

    if (routeRequestedRef.current) {
      return;
    }

    if (
      !socketRef.current ||
      socketRef.current.readyState !==
      WebSocket.OPEN
    ) {
      return;
    }

    routeRequestedRef.current = true;

    async function generateRoute() {
      try {
        setRouteGenerating(true);
        setError("");

        // ------------------------------------------
        // 1. PLAYER LOCATIONS
        // ------------------------------------------

        const playerA = {
          lat: myLocation.lat,
          lng: myLocation.lng,
        };

        const playerB = {
          lat: friendLocation.lat,
          lng: friendLocation.lng,
        };

        // ------------------------------------------
        // 2. RUN QWEN LOCALLY
        // ------------------------------------------

        console.log(
          "🤖 Generating spatial plan locally..."
        );

        const spatialPlan =
          await generateSpatialPlanWithQwen({
            prompt: challenge.prompt,

            travelMode:
              challenge.mode,

            maxDistanceKm:
              challenge.maxDistanceKm,

            maxTimeMinutes:
              challenge.maxTimeMinutes,

            onProgress: (progress) => {
              if (
                progress?.status ===
                "progress"
              ) {
                console.log(
                  `🤖 Loading Qwen: ${Math.round(
                    progress.progress || 0
                  )}%`
                );
              }
            },
          });

        console.log(
          "🧠 Qwen spatial plan:",
          spatialPlan
        );

        // ------------------------------------------
        // 3. MAKE SURE WEBSOCKET IS STILL OPEN
        // ------------------------------------------

        if (
          !socketRef.current ||
          socketRef.current.readyState !==
          WebSocket.OPEN
        ) {
          throw new Error(
            "WebSocket disconnected before route generation."
          );
        }

        // ------------------------------------------
        // 4. SEND SPATIAL PLAN TO FASTAPI
        // ------------------------------------------

        socketRef.current.send(
          JSON.stringify({
            type: "generate_route",

            players: [
              playerA,
              playerB,
            ],

            spatial_plan:
              spatialPlan,
          })
        );

        console.log(
          "🗺️ Spatial plan sent to backend."
        );
      } catch (err) {
        console.error(
          "❌ Route generation failed:",
          err
        );

        setError(
          err?.message ||
          "Could not generate route."
        );

        setRouteGenerating(false);

        // Allow retry
        routeRequestedRef.current = false;
      }
    }

    generateRoute();
  }, [
    screen,
    isCreator,
    myLocation,
    friendLocation,
    challenge,
    routeAttempt,
  ]);

  // ==================================================
  // WEBSOCKET
  // ==================================================

  useEffect(() => {
    if (!sessionId || !participantId) {
      return;
    }

    const socket = new WebSocket(
      `${WS_URL}/ws/${sessionId}/${participantId}`
    );

    socketRef.current = socket;

    socket.onopen = () => {
      console.log(
        "WebSocket connected."
      );

      if (pendingChallengeRef.current) {
        socket.send(
          JSON.stringify({
            type: "challenge_created",

            challenge:
              pendingChallengeRef.current,
          })
        );

        pendingChallengeRef.current =
          null;
      }
    };

    socket.onmessage = (event) => {
      try {
        const message =
          JSON.parse(event.data);

        console.log(
          "📨 Received:",
          message
        );

        // ------------------------------------------
        // SESSION STATE
        // ------------------------------------------

        if (
          message.type ===
          "session_state"
        ) {
          setParticipantCount(
            message.participant_count ||
            0
          );

          if (message.challenge) {
            setChallenge(
              message.challenge
            );
          }

          if (message.started) {
            beginChallenge(
              message.challenge
            );
          }

          return;
        }

        // ------------------------------------------
        // PARTICIPANT COUNT
        // ------------------------------------------

        if (
          message.type ===
          "participant_count"
        ) {
          setParticipantCount(
            message.count || 0
          );

          return;
        }

        // ------------------------------------------
        // CHALLENGE CREATED
        // ------------------------------------------

        if (
          message.type ===
          "challenge_created"
        ) {
          setChallenge(
            message.challenge
          );

          return;
        }

        // ------------------------------------------
        // CHALLENGE STARTED
        // ------------------------------------------

        if (
          message.type ===
          "challenge_started"
        ) {
          beginChallenge(
            message.challenge
          );

          return;
        }

        // ------------------------------------------
        // FRIEND LOCATION
        // ------------------------------------------

        if (
          message.type ===
          "location"
        ) {
          const location = {
            lat: message.lat,
            lng: message.lng,
            accuracy:
              message.accuracy,
          };

          setFriendLocation(
            location
          );

          setFriendStartLocation(
            (currentStart) => {
              if (currentStart) {
                return currentStart;
              }

              return location;
            }
          );

          setFriendPath(
            (currentPath) => [
              ...currentPath,
              [
                location.lat,
                location.lng,
              ],
            ]
          );

          return;
        }

        // ------------------------------------------
        // ROUTE CREATED
        // ------------------------------------------

        if (
          message.type ===
          "route_created"
        ) {
          console.log(
            "🗺️ BOTH routes received:",
            message.route
          );

          console.log(
            "👤 Player A route:",
            message.route?.player_a
          );

          console.log(
            "👤 Player B route:",
            message.route?.player_b
          );

          setPlannedRoute(
            message.route
          );

          setRouteGenerating(false);

          setRoutesReady(true);

          // Timer starts once both routes are ready
          setElapsedSeconds(0);

          setChallengeStartedAt(
            Date.now()
          );

          // Reset checkpoints
          setCheckpointState({
            activeIndex: 1,
            completed: {},
            times: {},
            finished: false,
          });

          setDistanceToCheckpoint(null);

          return;
        }

        // ------------------------------------------
        // FRIEND LEFT
        // ------------------------------------------

        if (
          message.type ===
          "participant_left"
        ) {
          setParticipantCount(
            (count) =>
              Math.max(
                0,
                count - 1
              )
          );

          setFriendLocation(null);

          return;
        }

        // ------------------------------------------
        // ERROR
        // ------------------------------------------

        if (
          message.type ===
          "error"
        ) {
          console.error(
            "Server error:",
            message.message
          );

          setError(
            message.message ||
            "Something went wrong."
          );

          setRouteGenerating(false);

          routeRequestedRef.current =
            false;

          return;
        }
      } catch (err) {
        console.error(
          "WebSocket message error:",
          err
        );
      }
    };

    socket.onerror = (event) => {
      console.error(
        "WebSocket error:",
        event
      );
    };

    socket.onclose = () => {
      console.log(
        "WebSocket disconnected."
      );
    };

    return () => {
      socket.close();
      stopLocationTracking();
    };
  }, [sessionId, participantId]);

  // ==================================================
  // CREATE CHALLENGE
  // ==================================================

  function createChallenge() {
    setError("");

    const cleanPrompt =
      challengePrompt.trim();

    if (!cleanPrompt) {
      setError(
        "Tell us what you want to draw."
      );

      return;
    }

    const newChallenge = {
      prompt: cleanPrompt,

      mode: travelMode,

      maxDistanceKm:
        Number(maxDistance),

      maxTimeMinutes:
        Number(maxTime),

      gameMode: GAME_MODE,
    };

    resetChallengeTracking();

    setChallenge(newChallenge);

    if (
      socketRef.current &&
      socketRef.current.readyState ===
      WebSocket.OPEN
    ) {
      socketRef.current.send(
        JSON.stringify({
          type: "challenge_created",

          challenge:
            newChallenge,
        })
      );
    } else {
      pendingChallengeRef.current =
        newChallenge;
    }
  }

  // ==================================================
  // START CHALLENGE
  // ==================================================

  function startChallenge() {
    setError("");

    if (!challenge) {
      setError(
        "Create a challenge first."
      );

      return;
    }

    if (participantCount < 2) {
      setError(
        "Waiting for your friend to join."
      );

      return;
    }

    if (
      !socketRef.current ||
      socketRef.current.readyState !==
      WebSocket.OPEN
    ) {
      setError(
        "Connection is not ready yet."
      );

      return;
    }

    socketRef.current.send(
      JSON.stringify({
        type: "start_challenge",
      })
    );
  }

  // ==================================================
  // HOME SCREEN
  // ==================================================

  if (screen === "home") {
    return (
      <div className="app">
        <div className="home-container">
          <h1>SyncWalk</h1>

          <p>
            Turn a walk with your friend
            into a real-world drawing
            challenge.
          </p>

          {error && (
            <div className="error">
              {error}
            </div>
          )}

          <button
            onClick={createSession}
          >
            Create a Session
          </button>

          <div className="divider">
            or
          </div>

          <input
            type="text"
            placeholder="Enter join code"
            value={joinCode}
            onChange={(event) =>
              setJoinCode(
                event.target.value
                  .toUpperCase()
              )
            }
            maxLength={6}
          />

          <button
            onClick={joinSession}
          >
            Join Session
          </button>
        </div>
      </div>
    );
  }

  // ==================================================
  // WAITING SCREEN
  // ==================================================

  if (screen === "waiting") {
    return (
      <div className="app">
        <div className="waiting-container">
          <h1>SyncWalk</h1>

          <p>
            Session code
          </p>

          <div className="session-code">
            {sessionCode}
          </div>

          <p>
            Players: {participantCount}/2
          </p>

          {error && (
            <div className="error">
              {error}
            </div>
          )}

          {/* CREATOR - NO CHALLENGE */}

          {isCreator &&
            !challenge && (
              <div className="challenge-form">
                <h2>
                  Create your challenge
                </h2>

                <input
                  type="text"
                  placeholder='Example: "I want to draw a star"'
                  value={challengePrompt}
                  onChange={(event) =>
                    setChallengePrompt(
                      event.target.value
                    )
                  }
                />

                <label>
                  Travel mode
                </label>

                <select
                  value={travelMode}
                  onChange={(event) =>
                    setTravelMode(
                      event.target.value
                    )
                  }
                >
                  <option value="walking">
                    Walking
                  </option>

                  <option value="cycling">
                    Cycling
                  </option>
                </select>

                <label>
                  Maximum distance (km)
                </label>

                <input
                  type="number"
                  min="1"
                  max="50"
                  value={maxDistance}
                  onChange={(event) =>
                    setMaxDistance(
                      event.target.value
                    )
                  }
                />

                <label>
                  Maximum time (minutes)
                </label>

                <input
                  type="number"
                  min="1"
                  max="180"
                  value={maxTime}
                  onChange={(event) =>
                    setMaxTime(
                      event.target.value
                    )
                  }
                />

                <button
                  onClick={
                    createChallenge
                  }
                >
                  Create Challenge
                </button>
              </div>
            )}

          {/* CREATOR - CHALLENGE READY */}

          {isCreator &&
            challenge && (
              <div className="challenge-preview">
                <h2>
                  Challenge Ready 🎯
                </h2>

                <p>
                  <strong>
                    {challenge.prompt}
                  </strong>
                </p>

                <p>
                  🚶 Mode:{" "}
                  {challenge.mode}
                </p>

                <p>
                  📏 Max distance:{" "}
                  {challenge.maxDistanceKm}{" "}
                  km
                </p>

                <p>
                  ⏱️ Max time:{" "}
                  {challenge.maxTimeMinutes}{" "}
                  minutes
                </p>

                <hr />

                <p>
                  🎮{" "}
                  <strong>
                    Individual Mode
                  </strong>
                </p>

                <p>
                  🏠 Start and finish at
                  your own starting location.
                </p>

                <p>
                  👣 You and your friend
                  draw the same challenge
                  independently.
                </p>

                <p>
                  🗺️ Both paths will appear
                  on the map.
                </p>

                {participantCount >= 2 ? (
                  <button
                    onClick={
                      startChallenge
                    }
                  >
                    Start Challenge
                  </button>
                ) : (
                  <p>
                    Waiting for your friend
                    to join...
                  </p>
                )}
              </div>
            )}

          {/* FRIEND */}

          {!isCreator && (
            <div className="challenge-preview">
              {!challenge && (
                <>
                  <h2>
                    Waiting for challenge...
                  </h2>

                  <p>
                    Ask the session creator
                    to create the challenge.
                  </p>
                </>
              )}

              {challenge && (
                <>
                  <h2>
                    Challenge Ready 🎯
                  </h2>

                  <p>
                    <strong>
                      {challenge.prompt}
                    </strong>
                  </p>

                  <p>
                    🚶 Mode:{" "}
                    {challenge.mode}
                  </p>

                  <p>
                    📏 Max distance:{" "}
                    {challenge.maxDistanceKm}{" "}
                    km
                  </p>

                  <p>
                    ⏱️ Max time:{" "}
                    {challenge.maxTimeMinutes}{" "}
                    minutes
                  </p>

                  <hr />

                  <p>
                    🎮{" "}
                    <strong>
                      Individual Mode
                    </strong>
                  </p>

                  <p>
                    🏠 Start and finish at
                    your own starting location.
                  </p>

                  <p>
                    👣 Draw the challenge
                    independently from your
                    friend.
                  </p>

                  <p>
                    Waiting for the creator
                    to start...
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ==================================================
  // SESSION / MAP SCREEN
  // ==================================================

  const myPlannedRoute = isCreator
    ? plannedRoute?.player_a
    : plannedRoute?.player_b;

  const friendPlannedRoute = isCreator
    ? plannedRoute?.player_b
    : plannedRoute?.player_a;

  return (
    <div className="app">

      {/* HEADER */}

      <div className="session-header">
        <div>
          <h1>
            SyncWalk
          </h1>

          <span>
            Session: {sessionCode}
          </span>
        </div>

        <div>
          <span>
            👥 {participantCount}/2
          </span>
        </div>
      </div>

      {/* CHALLENGE INFO */}

      {challenge && (
        <div className="challenge-bar">
          <div>
            🎯 {challenge.prompt}
          </div>

          <div>
            🎮 Individual
          </div>

          <div>
            {challenge.mode ===
              "walking"
              ? "🚶 Walking"
              : "🚴 Cycling"}
          </div>

          <div>
            📏{" "}
            {challenge.maxDistanceKm}{" "}
            km
          </div>
        </div>
      )}

      {/* TIMER */}

      <div className="challenge-timer">
        <span>
          ⏱️{" "}
          {formatTime(
            elapsedSeconds
          )}
        </span>

        {challenge && (
          <span>
            {" "}
            /{" "}
            {formatTime(
              Number(
                challenge.maxTimeMinutes
              ) * 60
            )}
          </span>
        )}
      </div>

      {/* ROUTE GENERATING */}

      {routeGenerating && (
        <div className="route-generating">
          🤖 AI is planning your route
          locally...
          <br />

          <small>
            Your browser is running Qwen
            locally. The first run may
            take a little longer.
          </small>
        </div>
      )}

      {/* MAP */}

      <MapContainer
        center={[
          20.5937,
          78.9629,
        ]}
        zoom={5}
        style={{
          height: "70vh",
          width: "100%",
        }}
      >
        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <MapController
          myLocation={myLocation}
          friendLocation={
            friendLocation
          }
        />

        {/* MY MARKER */}

        {myLocation && (
          <Marker
            position={[
              myLocation.lat,
              myLocation.lng,
            ]}
          >
            <Popup>
              <strong>
                You
              </strong>

              <br />

              Accuracy:{" "}
              {Math.round(
                myLocation.accuracy ||
                0
              )}
              m
            </Popup>
          </Marker>
        )}

        {/* FRIEND MARKER */}

        {friendLocation && (
          <Marker
            position={[
              friendLocation.lat,
              friendLocation.lng,
            ]}
          >
            <Popup>
              <strong>
                Your Friend
              </strong>

              <br />

              Accuracy:{" "}
              {Math.round(
                friendLocation.accuracy ||
                0
              )}
              m
            </Popup>
          </Marker>
        )}

        {/* MY START */}

        {myStartLocation && (
          <CircleMarker
            center={[
              myStartLocation.lat,
              myStartLocation.lng,
            ]}
            radius={8}
            pathOptions={{
              color: "#6C63FF",
              fillColor: "#6C63FF",
              fillOpacity: 0.8,
            }}
          >
            <Popup>
              🏠 Your starting point
            </Popup>
          </CircleMarker>
        )}

        {/* FRIEND START */}

        {friendStartLocation && (
          <CircleMarker
            center={[
              friendStartLocation.lat,
              friendStartLocation.lng,
            ]}
            radius={8}
            pathOptions={{
              color: "#F59E0B",
              fillColor: "#F59E0B",
              fillOpacity: 0.8,
            }}
          >
            <Popup>
              🏠 Friend's starting point
            </Popup>
          </CircleMarker>
        )}

        {/* MY ACTUAL PATH */}

        {myPath.length >= 2 && (
          <Polyline
            positions={myPath}
            pathOptions={{
              color: "#6C63FF",
              weight: 5,
              opacity: 0.85,
            }}
          />
        )}

        {/* FRIEND ACTUAL PATH */}

        {friendPath.length >= 2 && (
          <Polyline
            positions={friendPath}
            pathOptions={{
              color: "#F59E0B",
              weight: 5,
              opacity: 0.85,
            }}
          />
        )}

        {/* MY PLANNED ROUTE */}

        {myPlannedRoute?.points
          ?.length > 1 && (
            <Polyline
              positions={
                myPlannedRoute.points
              }
              pathOptions={{
                color: "#6C63FF",
                weight: 7,
                opacity: 0.35,
              }}
            />
          )}

        {/* FRIEND PLANNED ROUTE */}

        {friendPlannedRoute?.points
          ?.length > 1 && (
            <Polyline
              positions={
                friendPlannedRoute.points
              }
              pathOptions={{
                color: "#F59E0B",
                weight: 7,
                opacity: 0.35,
              }}
            />
          )}

        {/* CHECKPOINT MARKERS */}

        {checkpointWaypoints.map(
          (point, index) => {
            // Don't show starting point
            // as a checkpoint.
            if (index === 0) {
              return null;
            }

            const [lat, lng] = point;

            const completed =
              checkpointState
                .completed[index];

            const active =
              checkpointState
                .activeIndex ===
              index;

            return (
              <Marker
                key={`checkpoint-${index}`}
                position={[
                  lat,
                  lng,
                ]}
              >
                <Popup>
                  <div
                    style={{
                      textAlign:
                        "center",
                      minWidth:
                        "150px",
                    }}
                  >
                    <strong>
                      {index ===
                        checkpointWaypoints.length -
                        1
                        ? "🏁 FINISH"
                        : `🎯 CHECKPOINT ${String.fromCharCode(
                          64 + index
                        )}`}
                    </strong>

                    <br />

                    {completed ? (
                      <span>
                        ✅ Completed
                        <br />
                        ⏱{" "}
                        {formatCheckpointTime(
                          checkpointState
                            .times[
                          index
                          ]
                        )}
                      </span>
                    ) : active ? (
                      <span>
                        📍 Next
                        checkpoint
                      </span>
                    ) : (
                      <span>
                        🔒 Locked
                      </span>
                    )}
                  </div>
                </Popup>
              </Marker>
            );
          }
        )}
      </MapContainer>

      {/* ROUTE INFO */}

      {plannedRoute && (
        <div className="route-info">
          <div>
            🧠 AI shape:{" "}
            {
              plannedRoute
                ?.spatial_plan
                ?.shape_name
            }
          </div>

          <div>
            🗺️ Your route:{" "}
            {
              myPlannedRoute
                ?.distance_km
            }{" "}
            km
          </div>

          <div>
            🗺️ Friend route:{" "}
            {
              friendPlannedRoute
                ?.distance_km
            }{" "}
            km
          </div>
        </div>
      )}

      {/* CHECKPOINT STATUS */}

      {checkpointWaypoints.length >
        1 && (
          <div
            style={{
              marginTop: "12px",
              padding: "14px",
              borderRadius: "14px",
              background: "#f8f9ff",
              border:
                "1px solid #e4e7f5",
            }}
          >
            <div
              style={{
                fontWeight: 700,
                fontSize: "16px",
                marginBottom: "10px",
              }}
            >
              🎯 Challenge Checkpoints
            </div>

            {checkpointWaypoints
              .slice(1)
              .map((_, i) => {
                const index = i + 1;

                const completed =
                  checkpointState
                    .completed[index];

                const active =
                  checkpointState
                    .activeIndex ===
                  index;

                const label =
                  index ===
                    checkpointWaypoints.length -
                    1
                    ? "🏁 Finish"
                    : `🔵 Checkpoint ${String.fromCharCode(
                      64 + index
                    )}`;

                return (
                  <div
                    key={`checkpoint-status-${index}`}
                    style={{
                      display: "flex",
                      alignItems:
                        "center",
                      justifyContent:
                        "space-between",
                      padding: "8px 0",
                      borderBottom:
                        index <
                          checkpointWaypoints.length -
                          1
                          ? "1px solid #eee"
                          : "none",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontWeight:
                            active ||
                              completed
                              ? 600
                              : 400,
                        }}
                      >
                        {completed
                          ? "✅"
                          : active
                            ? "📍"
                            : "🔒"}{" "}
                        {label}
                      </div>

                      {completed && (
                        <div
                          style={{
                            fontSize:
                              "12px",
                            color:
                              "#666",
                            marginTop:
                              "2px",
                          }}
                        >
                          ⏱{" "}
                          {formatCheckpointTime(
                            checkpointState
                              .times[
                            index
                            ]
                          )}
                        </div>
                      )}
                    </div>

                    {active &&
                      !completed && (
                        <span
                          style={{
                            fontSize:
                              "12px",
                            fontWeight: 600,
                          }}
                        >
                          {distanceToCheckpoint !==
                            null
                            ? `${distanceToCheckpoint} m away`
                            : "Locating..."}
                        </span>
                      )}
                  </div>
                );
              })}

            {/* CHECK IN BUTTON */}

            {!checkpointState.finished &&
              activeCheckpoint &&
              isNearCheckpoint && (
                <button
                  type="button"
                  onClick={
                    handleCheckpointCheckIn
                  }
                  style={{
                    width: "100%",
                    marginTop:
                      "12px",
                    padding: "12px",
                    border: "none",
                    borderRadius:
                      "10px",
                    cursor:
                      "pointer",
                    fontWeight: 700,
                    fontSize:
                      "15px",
                  }}
                >
                  📍 CHECK IN
                </button>
              )}

            {/* FINISHED */}

            {checkpointState.finished && (
              <div
                style={{
                  marginTop:
                    "12px",
                  padding: "12px",
                  borderRadius:
                    "10px",
                  textAlign:
                    "center",
                  fontWeight: 700,
                }}
              >
                🎉 Challenge Complete!
              </div>
            )}
          </div>
        )}

      {/* STATUS */}

      <div className="session-status">
        <p>
          📍 Your points:{" "}
          {myPath.length}
        </p>

        <p>
          👥 Friend points:{" "}
          {friendPath.length}
        </p>

        {myLocation ? (
          <p>
            🟢 Your location is being
            shared
          </p>
        ) : (
          <p>
            🟡 Getting your location...
          </p>
        )}

        {friendLocation ? (
          <p>
            🟢 Friend location received
          </p>
        ) : (
          <p>
            🟡 Waiting for friend's
            location...
          </p>
        )}
      </div>

      {error && (
        <div className="error">
          {error}
        </div>
      )}
    </div>
  );
}

export default App;