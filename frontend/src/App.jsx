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

// For now we are only implementing Individual Mode.
const GAME_MODE = "individual";

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
// GPS → LOCAL 2D COORDINATES
// ==================================================

function gpsToLocal(lat, lng, originLat, originLng) {
  const latScale = 111320;

  const lonScale =
    111320 *
    Math.cos((originLat * Math.PI) / 180);

  const x =
    (lng - originLng) * lonScale;

  const y =
    (lat - originLat) * latScale;

  return {
    x,
    y,
  };
}

// ==================================================
// CALCULATE RELATIVE PLAYER CONTEXT
// ==================================================

function calculatePlayerContext(playerA, playerB) {
  const midLat =
    (playerA.lat + playerB.lat) / 2;

  const midLng =
    (playerA.lng + playerB.lng) / 2;

  const a = gpsToLocal(
    playerA.lat,
    playerA.lng,
    midLat,
    midLng
  );

  const b = gpsToLocal(
    playerB.lat,
    playerB.lng,
    midLat,
    midLng
  );

  const separation = Math.hypot(
    b.x - a.x,
    b.y - a.y
  );

  return {
    origin: {
      lat: midLat,
      lon: midLng,
    },

    player_a: {
      x_m: Number(a.x.toFixed(2)),
      y_m: Number(a.y.toFixed(2)),
    },

    player_b: {
      x_m: Number(b.x.toFixed(2)),
      y_m: Number(b.y.toFixed(2)),
    },

    separation_m:
      Number(separation.toFixed(2)),
  };
}

// ==================================================
// EXISTING CLIENT-SIDE QWEN
// ==================================================
//
// IMPORTANT:
//
// Replace ONLY the body of this function with
// your EXISTING working browser-Qwen code.
//
// It must return:
//
// {
//   shape_name: "star",
//   points: [
//     [-0.8, 0],
//     [-0.2, 0.2],
//     [0, 0.8],
//     ...
//   ],
//   rotation_degrees: 0
// }
//
// DO NOT call the FastAPI server for Qwen here.
// ==================================================

async function generateSpatialPlanWithQwen({
  prompt,
  travelMode,
  maxDistanceKm,
  playerContext,
}) {
  /*
   * YOUR EXISTING CLIENT-SIDE QWEN CODE GOES HERE.
   *
   * Example expected final result:
   *
   * return {
   *   shape_name: "star",
   *   points: [
   *     [-0.8, 0],
   *     [-0.25, 0.2],
   *     [0, 0.8],
   *     [0.25, 0.2],
   *     [0.8, 0],
   *     [0.25, -0.2],
   *     [0, -0.8],
   *     [-0.25, -0.2],
   *     [-0.8, 0]
   *   ],
   *   rotation_degrees: 0
   * };
   */

  throw new Error(
    "Connect your existing client-side Qwen function inside generateSpatialPlanWithQwen()."
  );
}

// ==================================================
// APP
// ==================================================

function App() {
  // ==================================================
  // SESSION STATE
  // ==================================================

  const [screen, setScreen] = useState("home");

  const [isCreator, setIsCreator] =
    useState(false);

  const [joinCode, setJoinCode] =
    useState("");

  const [sessionCode, setSessionCode] =
    useState("");

  const [sessionId, setSessionId] =
    useState("");

  const [participantId, setParticipantId] =
    useState("");

  const [participantCount, setParticipantCount] =
    useState(0);

  const [myLocation, setMyLocation] =
    useState(null);

  const [friendLocation, setFriendLocation] =
    useState(null);

  const [error, setError] =
    useState("");

  // ==================================================
  // CHALLENGE STATE
  // ==================================================

  const [challengePrompt, setChallengePrompt] =
    useState("");

  const [travelMode, setTravelMode] =
    useState("walking");

  const [maxDistance, setMaxDistance] =
    useState(5);

  const [maxTime, setMaxTime] =
    useState(30);

  const [challenge, setChallenge] =
    useState(null);

  // ==================================================
  // INDIVIDUAL MODE STATE
  // ==================================================

  const [myPath, setMyPath] =
    useState([]);

  const [friendPath, setFriendPath] =
    useState([]);

  const [myStartLocation, setMyStartLocation] =
    useState(null);

  const [friendStartLocation, setFriendStartLocation] =
    useState(null);

  const [challengeStartedAt, setChallengeStartedAt] =
    useState(null);

  const [elapsedSeconds, setElapsedSeconds] =
    useState(0);

  // ==================================================
  // ROUTE STATE
  // ==================================================

  const socketRef = useRef(null);

  const watchIdRef = useRef(null);

  const pendingChallengeRef =
    useRef(null);

  const [plannedRoute, setPlannedRoute] =
    useState(null);

  const routeRequestedRef =
    useRef(false);

  const [routeGenerating, setRouteGenerating] =
    useState(false);

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
  // RESET CHALLENGE
  // ==================================================

  function resetChallengeTracking() {
    setMyPath([]);
    setFriendPath([]);

    setMyLocation(null);
    setFriendLocation(null);

    setMyStartLocation(null);
    setFriendStartLocation(null);

    setElapsedSeconds(0);
    setChallengeStartedAt(null);

    setPlannedRoute(null);
    setRouteGenerating(false);

    routeRequestedRef.current = false;
  }

  // ==================================================
  // BEGIN CHALLENGE
  // ==================================================

  function beginChallenge(challengeData) {
    if (challengeData) {
      setChallenge(challengeData);
    }

    resetChallengeTracking();

    setChallengeStartedAt(Date.now());

    startLocationTracking();

    setScreen("session");
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

      const data =
        await response.json();

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
    // Don't join twice
    if (sessionId) {
      return;
    }

    try {
      setError("");
      console.log("JOIN CODE INPUT:", joinCode);
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
            "Content-Type": "application/json",
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
      setParticipantId(data.participant_id);
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
            lat:
              position.coords.latitude,

            lng:
              position.coords.longitude,

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
            "🗺️ Route received:",
            message.route
          );

          setPlannedRoute(
            message.route
          );

          setRouteGenerating(false);

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
  // GENERATE ROUTE
  //
  // QWEN RUNS LOCALLY IN THE CREATOR'S BROWSER.
  //
  // FastAPI ONLY RECEIVES THE SPATIAL PLAN.
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

        const playerA = {
          lat: myLocation.lat,
          lng: myLocation.lng,
        };

        const playerB = {
          lat: friendLocation.lat,
          lng: friendLocation.lng,
        };

        // ------------------------------------------
        // 1. Calculate relative positions
        // ------------------------------------------

        const playerContext =
          calculatePlayerContext(
            playerA,
            playerB
          );

        console.log(
          "📍 Player context:",
          playerContext
        );

        // ------------------------------------------
        // 2. LOCAL QWEN
        // ------------------------------------------

        console.log(
          "🤖 Generating spatial plan locally..."
        );

        const spatialPlan =
          await generateSpatialPlanWithQwen({
            prompt:
              challenge.prompt,

            travelMode:
              challenge.mode,

            maxDistanceKm:
              challenge.maxDistanceKm,

            playerContext,
          });

        console.log(
          "🤖 Spatial plan:",
          spatialPlan
        );

        // ------------------------------------------
        // 3. SEND PLAN TO FASTAPI
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
          err.message ||
          "Could not generate route."
        );

        setRouteGenerating(false);

        // Allow retry
        routeRequestedRef.current =
          false;
      }
    }

    generateRoute();

  }, [
    screen,
    isCreator,
    myLocation,
    friendLocation,
    challenge,
  ]);

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
                  onClick={createChallenge}
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
                  {challenge.maxDistanceKm} km
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
                    onClick={startChallenge}
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

  const myPlannedRoute =
    isCreator
      ? plannedRoute?.player_a
      : plannedRoute?.player_b;

  const friendPlannedRoute =
    isCreator
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
            {challenge.maxDistanceKm} km
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
          🤖 Creating your route...
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
          friendLocation={friendLocation}
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
                myLocation.accuracy || 0
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

        {myPlannedRoute?.points?.length >
          1 && (
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