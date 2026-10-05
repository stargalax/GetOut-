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
import {
  Footprints,
  Bike,
  Plus,
  LogIn,
  Users,
  Target,
  Flag,
  MapPin,
  Lock,
  CheckCircle2,
  Timer,
  Route as RouteIcon,
  Ruler,
  Clock,
  Copy,
  Check,
  Trophy,
  Map as MapIcon,
  Home,
  Play,
  Hourglass,
  Sparkles,
} from "lucide-react";
import WalkingFigure from "./WalkingFirgure";
import "./App.css";
import { generateSpatialPlanWithQwen } from "./qwen";

// ==================================================
// CONFIG
// ==================================================

const API_URL = import.meta.env.VITE_API_URL;
const WS_URL = API_URL.replace(/^http/, "ws");
const CHECKPOINT_RADIUS_METERS = 50;
const GAME_MODE = "individual"; // only Individual Mode for now

// OpenStreetMap tiles need no API key (CARTO's now do).
const TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const ME_COLOR = "#6b5bea";
const FRIEND_COLOR = "#ff8f7a";

// ==================================================
// HELPERS
// ==================================================

const getDistanceMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371000;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const formatTime = (totalSeconds) => {
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const s = String(Math.floor(totalSeconds % 60)).padStart(2, "0");
  return `${m}:${s}`;
};

const cpLetter = (i, total) =>
  i === total - 1 ? "F" : String.fromCharCode(64 + i);

const cpLabel = (i, total) =>
  i === total - 1 ? "Finish" : `Checkpoint ${String.fromCharCode(64 + i)}`;

const pin = (cls, label = "") =>
  L.divIcon({
    className: "pin-wrap",
    html: `<div class="pin ${cls}">${label}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -14],
  });

// ==================================================
// SMALL UI PIECES
// ==================================================

function Logo({ small }) {
  return (
    <div className={`logo ${small ? "small" : ""}`}>
      <span className="logo-mark">
        <Footprints size={small ? 16 : 22} />
      </span>
      <span>GetOut!</span>
    </div>
  );
}

function Blobs() {
  return (
    <div className="blobs" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </div>
  );
}

function ChallengeSummary({ challenge, isCreator }) {
  const walking = challenge.mode === "walking";
  return (
    <>
      <h2 className="prompt">{challenge.prompt}</h2>

      <div className="chip-row">
        <span className="chip lav">
          {walking ? <Footprints size={15} /> : <Bike size={15} />}
          {walking ? "Walking" : "Cycling"}
        </span>
        <span className="chip mint">
          <Ruler size={15} /> {challenge.maxDistanceKm} km
        </span>
        <span className="chip peach">
          <Clock size={15} /> {challenge.maxTimeMinutes} min
        </span>
        <span className="chip butter">
          <Target size={15} /> Individual mode
        </span>
      </div>

      <ul className="rules">
        <li>
          <Home size={18} />
          Start and finish at your own starting point.
        </li>
        <li>
          <Footprints size={18} />
          {isCreator
            ? "You and your friend draw the same shape independently."
            : "Draw the same shape independently from your friend."}
        </li>
        <li>
          <MapIcon size={18} />
          Both paths appear live on the map.
        </li>
      </ul>
    </>
  );
}

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
    map.flyTo([location.lat, location.lng], 16, { duration: 1.2 });
    hasCentered.current = true;
  }, [myLocation, friendLocation, map]);

  return null;
}

// ==================================================
// APP
// ==================================================

function App() {
  // ---------------- session ----------------
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
  const [copied, setCopied] = useState(false);

  // ---------------- challenge ----------------
  const [challengePrompt, setChallengePrompt] = useState("");
  const [travelMode, setTravelMode] = useState("walking");
  const [maxDistance, setMaxDistance] = useState(5);
  const [maxTime, setMaxTime] = useState(30);
  const [challenge, setChallenge] = useState(null);

  // ---------------- checkpoints ----------------
  const [checkpointState, setCheckpointState] = useState({
    activeIndex: 1,
    completed: {},
    times: {},
    finished: false,
  });
  const [distanceToCheckpoint, setDistanceToCheckpoint] = useState(null);

  // ---------------- individual mode ----------------
  const [myPath, setMyPath] = useState([]);
  const [friendPath, setFriendPath] = useState([]);
  const [myStartLocation, setMyStartLocation] = useState(null);
  const [friendStartLocation, setFriendStartLocation] = useState(null);
  const [challengeStartedAt, setChallengeStartedAt] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // ---------------- route ----------------
  const socketRef = useRef(null);
  const watchIdRef = useRef(null);
  const pendingChallengeRef = useRef(null);
  const routeRequestedRef = useRef(false);
  const [plannedRoute, setPlannedRoute] = useState(null);
  const [routeGenerating, setRouteGenerating] = useState(false);
  const [routesReady, setRoutesReady] = useState(false);
  const [routeAttempt] = useState(0);

  // ---------------- derived ----------------
  const myPlannedRoute = isCreator
    ? plannedRoute?.player_a
    : plannedRoute?.player_b;
  const friendPlannedRoute = isCreator
    ? plannedRoute?.player_b
    : plannedRoute?.player_a;

  const checkpointWaypoints = myPlannedRoute?.waypoints || [];
  const activeCheckpoint =
    checkpointWaypoints[checkpointState.activeIndex] || null;

  let isNearCheckpoint = false;
  if (myLocation && activeCheckpoint) {
    const [lat, lng] = activeCheckpoint;
    isNearCheckpoint =
      getDistanceMeters(myLocation.lat, myLocation.lng, lat, lng) <=
      CHECKPOINT_RADIUS_METERS;
  }

  // ==================================================
  // CHECKPOINT CHECK-IN
  // ==================================================

  const handleCheckpointCheckIn = () => {
    if (!myLocation || !activeCheckpoint || !challengeStartedAt) return;

    const [lat, lng] = activeCheckpoint;
    const distance = getDistanceMeters(
      myLocation.lat,
      myLocation.lng,
      lat,
      lng
    );
    if (distance > CHECKPOINT_RADIUS_METERS) return;

    const elapsed = Math.floor((Date.now() - challengeStartedAt) / 1000);
    const currentIndex = checkpointState.activeIndex;
    const lastIndex = checkpointWaypoints.length - 1;

    setCheckpointState((prev) => ({
      ...prev,
      completed: { ...prev.completed, [currentIndex]: true },
      times: { ...prev.times, [currentIndex]: elapsed },
      activeIndex: currentIndex < lastIndex ? currentIndex + 1 : currentIndex,
      finished: currentIndex === lastIndex,
    }));
  };

  // ==================================================
  // TIMER
  // ==================================================

  useEffect(() => {
    if (!challengeStartedAt) return;
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - challengeStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [challengeStartedAt]);

  // ==================================================
  // CHECKPOINT DISTANCE
  // ==================================================

  useEffect(() => {
    if (!myLocation || !activeCheckpoint) {
      setDistanceToCheckpoint(null);
      return;
    }
    const [lat, lng] = activeCheckpoint;
    setDistanceToCheckpoint(
      Math.round(getDistanceMeters(myLocation.lat, myLocation.lng, lat, lng))
    );
  }, [myLocation, activeCheckpoint]);

  // ==================================================
  // RESET / BEGIN
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
    setCheckpointState({
      activeIndex: 1,
      completed: {},
      times: {},
      finished: false,
    });
    setDistanceToCheckpoint(null);
    routeRequestedRef.current = false;
  }

  function beginChallenge(challengeData) {
    setChallenge(challengeData);
    resetChallengeTracking();
    startLocationTracking();
    setScreen("session");
    // Timer starts when route_created is received.
  }

  // ==================================================
  // CREATE / JOIN SESSION
  // ==================================================

  async function createSession() {
    try {
      setError("");
      const response = await fetch(`${API_URL}/sessions`, { method: "POST" });
      if (!response.ok) throw new Error("Could not create session.");
      const data = await response.json();

      setSessionId(data.session_id);
      setSessionCode(data.join_code);
      setParticipantId(crypto.randomUUID());
      setIsCreator(true);
      setScreen("waiting");
    } catch (err) {
      console.error(err);
      setError("Could not create session.");
    }
  }

  async function joinSession() {
    if (sessionId) return;

    try {
      setError("");
      const cleanCode = joinCode.trim().toUpperCase();

      if (cleanCode.length !== 6) {
        setError("Enter a valid 6-character join code.");
        return;
      }

      const response = await fetch(`${API_URL}/sessions/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ join_code: cleanCode }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Could not join session.");
      }

      setSessionId(data.session_id);
      setParticipantId(data.participant_id);
      setSessionCode(cleanCode);
      setIsCreator(false);
      if (data.challenge) setChallenge(data.challenge);
      setScreen("waiting");
    } catch (err) {
      console.error(err);
      setError(err.message || "Could not join session.");
    }
  }

  function copyCode() {
    navigator.clipboard?.writeText(sessionCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  // ==================================================
  // LOCATION TRACKING
  // ==================================================

  function startLocationTracking() {
    if (!navigator.geolocation) {
      setError("Geolocation is not supported by this browser.");
      return;
    }
    if (watchIdRef.current !== null) return;

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const location = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        };

        setMyLocation(location);
        setMyStartLocation((start) => start || location);
        setMyPath((path) => [...path, [location.lat, location.lng]]);

        if (
          socketRef.current &&
          socketRef.current.readyState === WebSocket.OPEN
        ) {
          socketRef.current.send(
            JSON.stringify({
              type: "location",
              lat: location.lat,
              lng: location.lng,
              accuracy: location.accuracy,
            })
          );
        }
      },
      (geoError) => {
        console.error("Geolocation error:", geoError);
        setError(
          geoError.code === 1
            ? "Location permission was denied. Please allow location access."
            : "Could not get your current location."
        );
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }

  function stopLocationTracking() {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }

  // ==================================================
  // ROUTE GENERATION
  // Qwen runs locally in the creator's browser.
  // FastAPI only receives the spatial plan.
  // ==================================================

  useEffect(() => {
    if (screen !== "session") return;
    if (!isCreator) return;
    if (!myLocation || !friendLocation) return;
    if (!challenge) return;
    if (routeRequestedRef.current) return;
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN)
      return;

    routeRequestedRef.current = true;

    async function generateRoute() {
      try {
        setRouteGenerating(true);
        setError("");

        const playerA = { lat: myLocation.lat, lng: myLocation.lng };
        const playerB = { lat: friendLocation.lat, lng: friendLocation.lng };

        const spatialPlan = await generateSpatialPlanWithQwen({
          prompt: challenge.prompt,
          travelMode: challenge.mode,
          maxDistanceKm: challenge.maxDistanceKm,
          maxTimeMinutes: challenge.maxTimeMinutes,
          onProgress: (progress) => {
            if (progress?.status === "progress") {
              console.log(
                `Loading Qwen: ${Math.round(progress.progress || 0)}%`
              );
            }
          },
        });

        if (
          !socketRef.current ||
          socketRef.current.readyState !== WebSocket.OPEN
        ) {
          throw new Error("WebSocket disconnected before route generation.");
        }

        socketRef.current.send(
          JSON.stringify({
            type: "generate_route",
            players: [playerA, playerB],
            spatial_plan: spatialPlan,
          })
        );
      } catch (err) {
        console.error("Route generation failed:", err);
        setError(err?.message || "Could not generate route.");
        setRouteGenerating(false);
        routeRequestedRef.current = false; // allow retry
      }
    }

    generateRoute();
  }, [screen, isCreator, myLocation, friendLocation, challenge, routeAttempt]);

  // ==================================================
  // WEBSOCKET
  // ==================================================

  useEffect(() => {
    if (!sessionId || !participantId) return;

    const socket = new WebSocket(`${WS_URL}/ws/${sessionId}/${participantId}`);
    socketRef.current = socket;

    socket.onopen = () => {
      if (pendingChallengeRef.current) {
        socket.send(
          JSON.stringify({
            type: "challenge_created",
            challenge: pendingChallengeRef.current,
          })
        );
        pendingChallengeRef.current = null;
      }
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === "session_state") {
          setParticipantCount(message.participant_count || 0);
          if (message.challenge) setChallenge(message.challenge);
          if (message.started) beginChallenge(message.challenge);
          return;
        }

        if (message.type === "participant_count") {
          setParticipantCount(message.count || 0);
          return;
        }

        if (message.type === "challenge_created") {
          setChallenge(message.challenge);
          return;
        }

        if (message.type === "challenge_started") {
          beginChallenge(message.challenge);
          return;
        }

        if (message.type === "location") {
          const location = {
            lat: message.lat,
            lng: message.lng,
            accuracy: message.accuracy,
          };
          setFriendLocation(location);
          setFriendStartLocation((start) => start || location);
          setFriendPath((path) => [...path, [location.lat, location.lng]]);
          return;
        }

        if (message.type === "route_created") {
          setPlannedRoute(message.route);
          setRouteGenerating(false);
          setRoutesReady(true);

          // Timer starts once both routes are ready
          setElapsedSeconds(0);
          setChallengeStartedAt(Date.now());
          setCheckpointState({
            activeIndex: 1,
            completed: {},
            times: {},
            finished: false,
          });
          setDistanceToCheckpoint(null);
          return;
        }

        if (message.type === "participant_left") {
          setParticipantCount((count) => Math.max(0, count - 1));
          setFriendLocation(null);
          return;
        }

        if (message.type === "error") {
          console.error("Server error:", message.message);
          setError(message.message || "Something went wrong.");
          setRouteGenerating(false);
          routeRequestedRef.current = false;
        }
      } catch (err) {
        console.error("WebSocket message error:", err);
      }
    };

    socket.onerror = (event) => console.error("WebSocket error:", event);
    socket.onclose = () => console.log("WebSocket disconnected.");

    return () => {
      socket.close();
      stopLocationTracking();
    };
  }, [sessionId, participantId]);

  // ==================================================
  // CREATE / START CHALLENGE
  // ==================================================

  function createChallenge() {
    setError("");
    const cleanPrompt = challengePrompt.trim();

    if (!cleanPrompt) {
      setError("Tell us what you want to draw.");
      return;
    }

    const newChallenge = {
      prompt: cleanPrompt,
      mode: travelMode,
      maxDistanceKm: Number(maxDistance),
      maxTimeMinutes: Number(maxTime),
      gameMode: GAME_MODE,
    };

    resetChallengeTracking();
    setChallenge(newChallenge);

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({ type: "challenge_created", challenge: newChallenge })
      );
    } else {
      pendingChallengeRef.current = newChallenge;
    }
  }

  function startChallenge() {
    setError("");

    if (!challenge) {
      setError("Create a challenge first.");
      return;
    }
    if (participantCount < 2) {
      setError("Waiting for your friend to join.");
      return;
    }
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setError("Connection is not ready yet.");
      return;
    }

    socketRef.current.send(JSON.stringify({ type: "start_challenge" }));
  }

  // ==================================================
  // HOME SCREEN
  // ==================================================

  if (screen === "home") {
    return (
      <div className="app">
        <Blobs />

        <main className="home">
          <section className="hero">
            <Logo />
            <h1>Walk a drawing into the map.</h1>
            <p>
              Turn a walk with your friend into a real-world drawing challenge.
              Pick a shape, set off from your own doorsteps, and watch both
              routes appear live.
            </p>
          </section>

          <section className="panel">
            {error && <div className="error">{error}</div>}

            <div className="panel-block">
              <h2>Start a new walk</h2>
              <p className="muted">You will get a code to share with a friend.</p>
              <button className="btn primary" onClick={createSession}>
                <Plus size={18} /> Create a session
              </button>
            </div>

            <div className="divider">
              <span>or</span>
            </div>

            <div className="panel-block">
              <h2>Join a friend</h2>
              <p className="muted">Enter the 6-character code they shared.</p>
              <div className="join-row">
                <input
                  className="code-input"
                  type="text"
                  placeholder="ABC123"
                  aria-label="Join code"
                  value={joinCode}
                  maxLength={6}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === "Enter" && joinSession()}
                />
                <button className="btn mint" onClick={joinSession}>
                  <LogIn size={18} /> Join
                </button>
              </div>
            </div>
          </section>
        </main>

        <WalkingFigure />
      </div>
    );
  }

  // ==================================================
  // WAITING SCREEN
  // ==================================================

  if (screen === "waiting") {
    return (
      <div className="app">
        <Blobs />

        <main className="wait">
          <aside className="panel code-panel">
            <Logo small />
            <p className="muted">Share this code with your friend</p>

            <button className="code" onClick={copyCode} aria-label="Copy code">
              {sessionCode}
              {copied ? <Check size={22} /> : <Copy size={22} />}
            </button>

            <div className="players">
              <span className={`avatar ${participantCount >= 1 ? "on" : ""}`}>
                <Users size={18} />
              </span>
              <span className={`avatar f ${participantCount >= 2 ? "on" : ""}`}>
                <Users size={18} />
              </span>
              <span className="muted">{participantCount}/2 joined</span>
            </div>
          </aside>

          <section className="panel main-panel">
            {error && <div className="error">{error}</div>}

            {isCreator && !challenge && (
              <div className="challenge-form">
                <h2>Create your challenge</h2>

                <label className="field">
                  <span>What do you want to draw?</span>
                  <input
                    type="text"
                    placeholder="A star, a heart, a cat"
                    value={challengePrompt}
                    onChange={(e) => setChallengePrompt(e.target.value)}
                  />
                </label>

                <div className="field">
                  <span>Travel mode</span>
                  <div className="seg">
                    <button
                      type="button"
                      className={travelMode === "walking" ? "on" : ""}
                      onClick={() => setTravelMode("walking")}
                    >
                      <Footprints size={17} /> Walking
                    </button>
                    <button
                      type="button"
                      className={travelMode === "cycling" ? "on" : ""}
                      onClick={() => setTravelMode("cycling")}
                    >
                      <Bike size={17} /> Cycling
                    </button>
                  </div>
                </div>

                <div className="field-row">
                  <label className="field">
                    <span>Max distance</span>
                    <div className="unit">
                      <input
                        type="number"
                        min="1"
                        max="50"
                        value={maxDistance}
                        onChange={(e) => setMaxDistance(e.target.value)}
                      />
                      <em>km</em>
                    </div>
                  </label>

                  <label className="field">
                    <span>Max time</span>
                    <div className="unit">
                      <input
                        type="number"
                        min="1"
                        max="180"
                        value={maxTime}
                        onChange={(e) => setMaxTime(e.target.value)}
                      />
                      <em>min</em>
                    </div>
                  </label>
                </div>

                <button className="btn primary" onClick={createChallenge}>
                  <Sparkles size={18} /> Create challenge
                </button>
              </div>
            )}

            {challenge && (
              <div className="challenge-preview">
                <ChallengeSummary challenge={challenge} isCreator={isCreator} />

                {isCreator && participantCount >= 2 && (
                  <button className="btn primary" onClick={startChallenge}>
                    <Play size={18} /> Start challenge
                  </button>
                )}

                {isCreator && participantCount < 2 && (
                  <p className="waiting-note">
                    <Hourglass size={16} /> Waiting for your friend to join
                  </p>
                )}

                {!isCreator && (
                  <p className="waiting-note">
                    <Hourglass size={16} /> Waiting for the creator to start
                  </p>
                )}
              </div>
            )}

            {!isCreator && !challenge && (
              <div className="challenge-preview empty">
                <Hourglass size={28} />
                <h2>Waiting for a challenge</h2>
                <p className="muted">
                  The session creator is choosing what to draw.
                </p>
              </div>
            )}
          </section>
        </main>

        <WalkingFigure />
      </div>
    );
  }

  // ==================================================
  // SESSION / MAP SCREEN
  // ==================================================

  const total = checkpointWaypoints.length;
  const showLoader = !routesReady && !error;
  const loaderTitle =
    !myLocation || !friendLocation
      ? "Finding you both"
      : isCreator
        ? "Planning your route"
        : "Waiting for the route";
  const loaderText =
    !myLocation || !friendLocation
      ? "Waiting for both locations to come through."
      : isCreator
        ? "Your browser is running Qwen locally. The first run may take a little longer."
        : "Your friend's device is drawing the plan.";

  return (
    <div className="app session-app">
      <Blobs />

      <header className="topbar">
        <Logo small />

        <div className="topbar-right">
          <span className="pill">Code {sessionCode}</span>
          <span className="pill">
            <Users size={15} /> {participantCount}/2
          </span>
          <span className="pill timer">
            <Timer size={15} />
            {formatTime(elapsedSeconds)}
            {challenge && (
              <small> / {formatTime(Number(challenge.maxTimeMinutes) * 60)}</small>
            )}
          </span>
        </div>
      </header>

      {challenge && (
        <div className="chips">
          <span className="chip lav strong">
            <Target size={15} /> {challenge.prompt}
          </span>
          <span className="chip butter">Individual</span>
          <span className="chip mint">
            {challenge.mode === "walking" ? (
              <Footprints size={15} />
            ) : (
              <Bike size={15} />
            )}
            {challenge.mode === "walking" ? "Walking" : "Cycling"}
          </span>
          <span className="chip peach">
            <Ruler size={15} /> {challenge.maxDistanceKm} km
          </span>
        </div>
      )}

      <div className="session-grid">
        <div className="map-wrap">
          <MapContainer className="map" center={[20.5937, 78.9629]} zoom={5}>
            <TileLayer
              attribution="&copy; OpenStreetMap contributors"
              url={TILES}
            />

            <MapController
              myLocation={myLocation}
              friendLocation={friendLocation}
            />

            {myLocation && (
              <Marker
                position={[myLocation.lat, myLocation.lng]}
                icon={pin("me")}
              >
                <Popup>
                  <strong>You</strong>
                  <br />
                  Accuracy: {Math.round(myLocation.accuracy || 0)}m
                </Popup>
              </Marker>
            )}

            {friendLocation && (
              <Marker
                position={[friendLocation.lat, friendLocation.lng]}
                icon={pin("friend")}
              >
                <Popup>
                  <strong>Your friend</strong>
                  <br />
                  Accuracy: {Math.round(friendLocation.accuracy || 0)}m
                </Popup>
              </Marker>
            )}

            {myStartLocation && (
              <CircleMarker
                center={[myStartLocation.lat, myStartLocation.lng]}
                radius={9}
                pathOptions={{
                  color: "#fff",
                  weight: 3,
                  fillColor: ME_COLOR,
                  fillOpacity: 1,
                }}
              >
                <Popup>Your starting point</Popup>
              </CircleMarker>
            )}

            {friendStartLocation && (
              <CircleMarker
                center={[friendStartLocation.lat, friendStartLocation.lng]}
                radius={9}
                pathOptions={{
                  color: "#fff",
                  weight: 3,
                  fillColor: FRIEND_COLOR,
                  fillOpacity: 1,
                }}
              >
                <Popup>Friend's starting point</Popup>
              </CircleMarker>
            )}

            {myPath.length >= 2 && (
              <Polyline
                positions={myPath}
                pathOptions={{ color: ME_COLOR, weight: 5, opacity: 0.9 }}
              />
            )}

            {friendPath.length >= 2 && (
              <Polyline
                positions={friendPath}
                pathOptions={{ color: FRIEND_COLOR, weight: 5, opacity: 0.9 }}
              />
            )}

            {myPlannedRoute?.points?.length > 1 && (
              <Polyline
                positions={myPlannedRoute.points}
                pathOptions={{ color: ME_COLOR, weight: 8, opacity: 0.28 }}
              />
            )}

            {friendPlannedRoute?.points?.length > 1 && (
              <Polyline
                positions={friendPlannedRoute.points}
                pathOptions={{ color: FRIEND_COLOR, weight: 8, opacity: 0.28 }}
              />
            )}

            {checkpointWaypoints.map((point, index) => {
              if (index === 0) return null; // start is not a checkpoint

              const [lat, lng] = point;
              const completed = checkpointState.completed[index];
              const active = checkpointState.activeIndex === index;
              const state = completed ? "done" : active ? "active" : "locked";

              return (
                <Marker
                  key={`checkpoint-${index}`}
                  position={[lat, lng]}
                  icon={pin(state, cpLetter(index, total))}
                >
                  <Popup>
                    <strong>{cpLabel(index, total)}</strong>
                    <br />
                    {completed
                      ? `Completed at ${formatTime(checkpointState.times[index])}`
                      : active
                        ? "Next checkpoint"
                        : "Locked"}
                  </Popup>
                </Marker>
              );
            })}
          </MapContainer>

          {showLoader && (
            <div className="loading-overlay">
              <div className="loading-card">
                <WalkingFigure fixed={false} height={150} />
                <h3>{loaderTitle}</h3>
                <p className="muted">{loaderText}</p>
              </div>
            </div>
          )}
        </div>

        <aside className="side">
          {plannedRoute && (
            <section className="card">
              <h3>
                <RouteIcon size={18} />
                {plannedRoute?.spatial_plan?.shape_name || "Your route"}
              </h3>
              <div className="route-rows">
                <div>
                  <i className="dot me" /> Your route
                  <b>{myPlannedRoute?.distance_km} km</b>
                </div>
                <div>
                  <i className="dot friend" /> Friend's route
                  <b>{friendPlannedRoute?.distance_km} km</b>
                </div>
              </div>
            </section>
          )}

          {total > 1 && (
            <section className="card">
              <h3>
                <Flag size={18} /> Checkpoints
              </h3>

              <ul className="cp-list">
                {checkpointWaypoints.slice(1).map((_, i) => {
                  const index = i + 1;
                  const completed = checkpointState.completed[index];
                  const active = checkpointState.activeIndex === index;

                  return (
                    <li
                      key={`cp-${index}`}
                      className={completed ? "done" : active ? "active" : ""}
                    >
                      <span className="cp-icon">
                        {completed ? (
                          <CheckCircle2 size={20} />
                        ) : active ? (
                          <MapPin size={20} />
                        ) : (
                          <Lock size={18} />
                        )}
                      </span>

                      <div>
                        <strong>{cpLabel(index, total)}</strong>
                        {completed && (
                          <small>
                            Reached at {formatTime(checkpointState.times[index])}
                          </small>
                        )}
                      </div>

                      {active && !completed && (
                        <em>
                          {distanceToCheckpoint !== null
                            ? `${distanceToCheckpoint} m away`
                            : "Locating..."}
                        </em>
                      )}
                    </li>
                  );
                })}
              </ul>

              {!checkpointState.finished &&
                activeCheckpoint &&
                isNearCheckpoint && (
                  <button
                    type="button"
                    className="btn primary"
                    onClick={handleCheckpointCheckIn}
                  >
                    <MapPin size={18} /> Check in
                  </button>
                )}

              {checkpointState.finished && (
                <div className="done-banner">
                  <Trophy size={20} /> Challenge complete
                </div>
              )}
            </section>
          )}

          <section className="card status">
            <h3>
              <Hourglass size={18} /> Live status
            </h3>
            <p>
              <i className={`dot ${myLocation ? "ok" : "wait"}`} />
              {myLocation
                ? "Your location is being shared"
                : "Getting your location"}
            </p>
            <p>
              <i className={`dot ${friendLocation ? "ok" : "wait"}`} />
              {friendLocation
                ? "Friend location received"
                : "Waiting for friend's location"}
            </p>
            <p className="muted">
              Points recorded: you {myPath.length}, friend {friendPath.length}
            </p>
          </section>
        </aside>
      </div>

      {error && <div className="error toast">{error}</div>}
    </div>
  );
}

export default App;