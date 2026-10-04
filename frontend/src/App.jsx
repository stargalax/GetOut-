import { useEffect, useRef, useState } from "react";

import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMap,
} from "react-leaflet";

import L from "leaflet";

import "leaflet/dist/leaflet.css";
import "./App.css";


// -------------------------------------------------------
// Fix Leaflet marker icons when using Vite
// -------------------------------------------------------

delete L.Icon.Default.prototype._getIconUrl;

L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",

  iconUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",

  shadowUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});


const API_URL = import.meta.env.VITE_API_URL;

const WS_URL = API_URL.replace(/^http/, "ws");


// -------------------------------------------------------
// Map controller
// -------------------------------------------------------

function MapController({
  myLocation,
  friendLocation,
}) {

  const map = useMap();

  const hasCentered = useRef(false);

  useEffect(() => {

    if (hasCentered.current) {
      return;
    }

    const location =
      myLocation || friendLocation;

    if (!location) {
      return;
    }

    map.flyTo(
      [location.lat, location.lng],
      16,
      {
        duration: 1.2,
      }
    );

    hasCentered.current = true;

  }, [
    myLocation,
    friendLocation,
    map,
  ]);

  return null;
}


// -------------------------------------------------------
// App
// -------------------------------------------------------

function App() {

  const [screen, setScreen] =
    useState("home");

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

  // -----------------------------------------------------
  // Challenge state
  // -----------------------------------------------------

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


  // -----------------------------------------------------
  // Refs
  // -----------------------------------------------------

  const socketRef =
    useRef(null);

  const watchIdRef =
    useRef(null);

  const pendingChallengeRef =
    useRef(null);


  // -----------------------------------------------------
  // Create session
  // -----------------------------------------------------

  async function createSession() {

    setError("");

    try {

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

      setSessionCode(
        data.join_code
      );

      setSessionId(
        data.session_id
      );

      const newParticipantId =
        crypto.randomUUID();

      setParticipantId(
        newParticipantId
      );

      setIsCreator(true);

      setScreen("waiting");

    } catch (error) {

      setError(
        error.message
      );

    }
  }


  // -------------------------------------------------------
  // Join session
  // -------------------------------------------------------

  async function joinSession() {

    setError("");

    const code =
      joinCode
        .trim()
        .toUpperCase();

    if (code.length !== 6) {

      setError(
        "Enter the 6-character code."
      );

      return;
    }

    try {

      const response = await fetch(
        `${API_URL}/sessions/join`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            join_code: code,
          }),
        }
      );

      const data =
        await response.json();

      if (!response.ok) {

        throw new Error(
          data.detail ||
          "Could not join session."
        );
      }

      setSessionCode(code);

      setSessionId(
        data.session_id
      );

      setParticipantId(
        data.participant_id
      );

      setIsCreator(false);

      // If challenge already exists,
      // immediately show it.
      if (data.challenge) {

        setChallenge(
          data.challenge
        );
      }

      setScreen("waiting");

    } catch (error) {

      setError(
        error.message
      );

    }
  }


  // -------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------

  useEffect(() => {

    if (
      screen !== "session" &&
      screen !== "waiting"
    ) {
      return;
    }

    if (
      !sessionId ||
      !participantId
    ) {
      return;
    }

    console.log(
      "🌐 WebSocket URL:",
      `${WS_URL}/ws/${sessionId}/${participantId}`
    );

    const socket =
      new WebSocket(
        `${WS_URL}/ws/${sessionId}/${participantId}`
      );

    socketRef.current =
      socket;


    // -----------------------------------------------------
    // Connected
    // -----------------------------------------------------

    socket.onopen = () => {

      console.log(
        "🟢 WebSocket connected"
      );

      // If creator created the challenge
      // before the socket finished connecting,
      // send it now.
      if (
        pendingChallengeRef.current
      ) {

        socket.send(
          JSON.stringify({
            type:
              "challenge_created",

            challenge:
              pendingChallengeRef.current,
          })
        );

        pendingChallengeRef.current =
          null;
      }
    };


    // -----------------------------------------------------
    // Messages
    // -----------------------------------------------------

    socket.onmessage = (event) => {

      const message =
        JSON.parse(event.data);


      // -----------------------------------------------
      // Session state
      // -----------------------------------------------

      if (
        message.type ===
        "session_state"
      ) {

        setParticipantCount(
          message.participant_count || 0
        );

        if (message.challenge) {

          setChallenge(
            message.challenge
          );
        }

        // If the challenge had already
        // started before this user connected.
        if (message.started) {

          setScreen("session");

          startLocationTracking();
        }
      }


      // -----------------------------------------------
      // Participant count
      // -----------------------------------------------

      if (
        message.type ===
        "participant_count"
      ) {

        setParticipantCount(
          message.count
        );
      }


      // -----------------------------------------------
      // Challenge created
      // -----------------------------------------------

      if (
        message.type ===
        "challenge_created"
      ) {

        console.log(
          "🎯 Challenge received:",
          message.challenge
        );

        setChallenge(
          message.challenge
        );

        setError("");
      }


      // -----------------------------------------------
      // Challenge started
      // -----------------------------------------------

      if (
        message.type ===
        "challenge_started"
      ) {

        console.log(
          "🚀 Challenge started!"
        );

        if (message.challenge) {

          setChallenge(
            message.challenge
          );
        }

        // NOW we ask for location.
        startLocationTracking();

        setScreen("session");
      }


      // -----------------------------------------------
      // Friend location
      // -----------------------------------------------

      if (
        message.type ===
        "location"
      ) {

        setFriendLocation({
          lat: message.lat,
          lng: message.lng,
          accuracy:
            message.accuracy,
        });
      }


      // -----------------------------------------------
      // Friend left
      // -----------------------------------------------

      if (
        message.type ===
        "participant_left"
      ) {

        setParticipantCount(
          (current) =>
            Math.max(
              0,
              current - 1
            )
        );

        setFriendLocation(null);
      }


      // -----------------------------------------------
      // Error
      // -----------------------------------------------

      if (
        message.type ===
        "error"
      ) {

        setError(
          message.message
        );
      }
    };


    // -----------------------------------------------------
    // Socket error
    // -----------------------------------------------------

    socket.onerror = (error) => {

      console.error(
        "❌ WebSocket error:",
        error
      );
    };


    // -----------------------------------------------------
    // Socket close
    // -----------------------------------------------------

    socket.onclose = (event) => {

      console.log(
        "🔌 WebSocket closed:",
        event.code,
        event.reason
      );
    };


    // -----------------------------------------------------
    // Cleanup
    // -----------------------------------------------------

    return () => {

      socket.close();

      stopLocationTracking();
    };

  }, [
    sessionId,
    participantId,
  ]);


  // -------------------------------------------------------
  // Location tracking
  // -------------------------------------------------------

  function startLocationTracking() {

    if (!navigator.geolocation) {

      setError(
        "Your browser does not support location."
      );

      return;
    }


    // Don't create multiple watchers.
    if (
      watchIdRef.current !== null
    ) {
      return;
    }


    console.log(
      "📍 Starting location tracking..."
    );


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


          console.log(
            "📍 My location:",
            location
          );


          setMyLocation(
            location
          );


          // Send location to friend.
          if (
            socketRef.current &&
            socketRef.current.readyState ===
            WebSocket.OPEN
          ) {

            socketRef.current.send(
              JSON.stringify({

                type: "location",

                ...location,
              })
            );
          }
        },


        (error) => {

          console.error(
            "📍 Location error:",
            error
          );


          if (
            error.code ===
            error.PERMISSION_DENIED
          ) {

            setError(
              "Location permission is required to start SyncWalk."
            );

          } else {

            setError(
              "Unable to get your location."
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


  // -------------------------------------------------------
  // Stop location tracking
  // -------------------------------------------------------

  function stopLocationTracking() {

    if (
      watchIdRef.current !== null
    ) {

      navigator.geolocation.clearWatch(
        watchIdRef.current
      );

      watchIdRef.current = null;
    }
  }


  // -------------------------------------------------------
  // Create challenge
  // -------------------------------------------------------

  function createChallenge() {

    if (
      !challengePrompt.trim()
    ) {

      setError(
        "Tell us what you want to draw."
      );

      return;
    }


    const newChallenge = {

      prompt:
        challengePrompt.trim(),

      mode:
        travelMode,

      maxDistanceKm:
        Number(maxDistance),

      maxTimeMinutes:
        Number(maxTime),
    };


    console.log(
      "🎯 Challenge:",
      newChallenge
    );


    setChallenge(
      newChallenge
    );

    setError("");


    // -----------------------------------------------
    // Send to backend
    // -----------------------------------------------

    if (
      socketRef.current &&
      socketRef.current.readyState ===
      WebSocket.OPEN
    ) {

      socketRef.current.send(
        JSON.stringify({

          type:
            "challenge_created",

          challenge:
            newChallenge,
        })
      );

    } else {

      // Socket isn't ready yet.
      // Send when it opens.
      pendingChallengeRef.current =
        newChallenge;
    }
  }


  // -------------------------------------------------------
  // Start challenge
  // -------------------------------------------------------

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
        "Connecting to your friend..."
      );

      return;
    }


    console.log(
      "🚀 Starting challenge..."
    );


    socketRef.current.send(
      JSON.stringify({
        type:
          "start_challenge",
      })
    );
  }


  // -------------------------------------------------------
  // Home
  // -------------------------------------------------------

  if (screen === "home") {

    return (

      <main className="app">

        <div className="card">

          <h1>
            SyncWalk
          </h1>

          <p>
            Walk together, even when you're apart.
          </p>


          <button
            onClick={createSession}
          >
            Create session
          </button>


          <div className="divider">
            or
          </div>


          <input
            value={joinCode}

            onChange={(event) =>
              setJoinCode(
                event.target.value.toUpperCase()
              )
            }

            placeholder="Enter join code"

            maxLength={6}
          />


          <button
            className="secondary"

            onClick={joinSession}
          >
            Join session
          </button>


          {error && (

            <p className="error">
              {error}
            </p>

          )}

        </div>

      </main>
    );
  }


  // -------------------------------------------------------
  // Waiting / challenge screen
  // -------------------------------------------------------

  if (screen === "waiting") {

    return (

      <main className="app">

        <div className="card challenge-card">


          {/* ============================================
              CREATOR
          ============================================ */}

          {isCreator && !challenge && (

            <>

              <h1>
                🎯 Create a Challenge
              </h1>

              <p>
                Share this code with your friend:
              </p>


              <div className="code">
                {sessionCode}
              </div>


              <p>
                Connected: {participantCount}/2
              </p>


              <div className="challenge-form">

                <label>
                  What do you want to draw?
                </label>


                <input
                  value={challengePrompt}

                  onChange={(event) =>
                    setChallengePrompt(
                      event.target.value
                    )
                  }

                  placeholder='I want to draw a star'
                />


                <label>
                  How are you travelling?
                </label>


                <div className="mode-buttons">

                  <button
                    type="button"

                    className={
                      travelMode === "walking"
                        ? "mode-button active"
                        : "mode-button"
                    }

                    onClick={() =>
                      setTravelMode(
                        "walking"
                      )
                    }
                  >
                    🚶 Walking
                  </button>


                  <button
                    type="button"

                    className={
                      travelMode === "cycling"
                        ? "mode-button active"
                        : "mode-button"
                    }

                    onClick={() =>
                      setTravelMode(
                        "cycling"
                      )
                    }
                  >
                    🚴 Cycling
                  </button>

                </div>


                <label>
                  Maximum distance
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


                <span className="distance-unit">
                  km
                </span>


                <label>
                  Maximum time
                </label>


                <input
                  type="number"

                  min="5"

                  max="180"

                  value={maxTime}

                  onChange={(event) =>
                    setMaxTime(
                      event.target.value
                    )
                  }
                />


                <span className="distance-unit">
                  minutes
                </span>


                <button
                  onClick={
                    createChallenge
                  }
                >
                  Create Challenge
                </button>


                {error && (

                  <p className="error">
                    {error}
                  </p>

                )}

              </div>

            </>
          )}


          {/* ============================================
              CREATOR — CHALLENGE READY
          ============================================ */}

          {isCreator && challenge && (

            <>

              <h1>
                🎯 Challenge Ready!
              </h1>


              <div className="code">
                {sessionCode}
              </div>


              <div className="challenge-preview">

                <strong>
                  "{challenge.prompt}"
                </strong>


                <p>
                  {challenge.mode === "walking"
                    ? "🚶 Walking"
                    : "🚴 Cycling"}
                </p>


                <p>
                  📏 {challenge.maxDistanceKm} km maximum
                </p>


                <p>
                  ⏱️ {challenge.maxTimeMinutes} minutes maximum
                </p>

              </div>


              <p>
                Connected: {participantCount}/2
              </p>


              {participantCount < 2 ? (

                <p>
                  ⏳ Waiting for your friend to join...
                </p>

              ) : (

                <>

                  <p>
                    🟢 Your friend has joined!
                  </p>


                  <button
                    onClick={
                      startChallenge
                    }
                  >
                    Start Challenge 🚀
                  </button>

                </>

              )}


              {error && (

                <p className="error">
                  {error}
                </p>

              )}

            </>
          )}


          {/* ============================================
              FRIEND — WAITING FOR CHALLENGE
          ============================================ */}

          {!isCreator && !challenge && (

            <>

              <h1>
                🤝 Waiting for your friend
              </h1>


              <div className="code">
                {sessionCode}
              </div>


              <p>
                Connected: {participantCount}/2
              </p>


              <p>
                ⏳ Your friend is creating the challenge...
              </p>


              {error && (

                <p className="error">
                  {error}
                </p>

              )}

            </>
          )}


          {/* ============================================
              FRIEND — CHALLENGE RECEIVED
          ============================================ */}

          {!isCreator && challenge && (

            <>

              <h1>
                🎯 Your Challenge
              </h1>


              <div className="challenge-preview">

                <strong>
                  "{challenge.prompt}"
                </strong>


                <p>
                  {challenge.mode === "walking"
                    ? "🚶 Walking"
                    : "🚴 Cycling"}
                </p>


                <p>
                  📏 {challenge.maxDistanceKm} km maximum
                </p>


                <p>
                  ⏱️ {challenge.maxTimeMinutes} minutes maximum
                </p>

              </div>


              <p>
                🟢 Your friend is ready.
              </p>


              <p>
                ⏳ Waiting for them to start...
              </p>


              {error && (

                <p className="error">
                  {error}
                </p>

              )}

            </>
          )}

        </div>

      </main>
    );
  }


  // -------------------------------------------------------
  // Map
  // -------------------------------------------------------

  const defaultPosition =
    myLocation
      ? [
        myLocation.lat,
        myLocation.lng,
      ]
      : [
        20.5937,
        78.9629,
      ];


  return (

    <main className="session">


      <header>

        <div>

          <strong>
            SyncWalk
          </strong>


          <span>
            {sessionCode}
          </span>

        </div>


        <div>
          {participantCount}/2 connected
        </div>

      </header>


      <div className="map-container">

        <MapContainer
          center={defaultPosition}
          zoom={16}
          className="map"
        >

          <MapController
            myLocation={myLocation}
            friendLocation={friendLocation}
          />


          <TileLayer
            attribution="&copy; OpenStreetMap contributors"

            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />


          {myLocation && (

            <Marker
              position={[
                myLocation.lat,
                myLocation.lng,
              ]}
            >

              <Popup>
                You 📍
              </Popup>

            </Marker>

          )}


          {friendLocation && (

            <Marker
              position={[
                friendLocation.lat,
                friendLocation.lng,
              ]}
            >

              <Popup>
                Friend 📍
              </Popup>

            </Marker>

          )}

        </MapContainer>

      </div>


      <div className="status">

        {myLocation
          ? "📍 Sharing your location"
          : "📍 Waiting for your location..."}


        {friendLocation && (

          <div>
            🟢 Friend location received
          </div>

        )}

      </div>

    </main>
  );
}


export default App;