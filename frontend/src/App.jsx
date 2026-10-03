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


// Fix Leaflet marker icons when using Vite.
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

function MapController({ myLocation, friendLocation }) {
  const map = useMap();
  const hasCentered = useRef(false);

  useEffect(() => {
    if (hasCentered.current) {
      return;
    }

    const location = myLocation || friendLocation;

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

  }, [myLocation, friendLocation, map]);

  return null;
}


function App() {

  const [screen, setScreen] = useState("home");

  const [participantToken, setParticipantToken] = useState("");

  const [joinCode, setJoinCode] = useState("");

  const [sessionCode, setSessionCode] = useState("");

  const [sessionId, setSessionId] = useState("");

  const [participantId, setParticipantId] = useState("");

  const [participantCount, setParticipantCount] = useState(0);

  const [myLocation, setMyLocation] = useState(null);

  const [friendLocation, setFriendLocation] = useState(null);

  const [error, setError] = useState("");

  const socketRef = useRef(null);

  const watchIdRef = useRef(null);


  // -------------------------------------------------------
  // Create session
  // -------------------------------------------------------

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
        throw new Error("Could not create session.");
      }

      const data = await response.json();

      setSessionCode(data.join_code);
      setSessionId(data.session_id);

      // Creator gets their own participant ID.
      const participantId = crypto.randomUUID();

      setParticipantId(data.participant_id);
      setParticipantToken(data.participant_token);

      setScreen("waiting");

    } catch (error) {

      setError(error.message);

    }
  }


  // -------------------------------------------------------
  // Join session
  // -------------------------------------------------------

  async function joinSession() {

    setError("");

    const code = joinCode.trim().toUpperCase();

    if (code.length !== 6) {
      setError("Enter the 6-character code.");
      return;
    }

    try {

      const response = await fetch(
        `${API_URL}/sessions/join`,
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
          },

          body: JSON.stringify({
            join_code: code,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.detail || "Could not join session."
        );
      }

      setSessionCode(code);
      setSessionId(data.session_id);
      setParticipantId(data.participant_id);
      setParticipantToken(data.participant_token);

      setScreen("session");

    } catch (error) {

      setError(error.message);

    }
  }


  // -------------------------------------------------------
  // Connect WebSocket
  // -------------------------------------------------------

  useEffect(() => {

    if (
      screen !== "session" &&
      screen !== "waiting"
    ) {
      return;
    }

    if (!sessionId || !participantId) {
      return;
    }
    console.log("🌐 WebSocket URL:", `${WS_URL}/ws/${sessionId}/${participantId}`);
    const socket = new WebSocket(
      `${WS_URL}/ws/${sessionId}/${participantId}`
    );

    socketRef.current = socket;


    socket.onopen = () => {

      console.log("WebSocket connected");

      setScreen("session");

      startLocationTracking();

    };


    socket.onmessage = (event) => {

      const message = JSON.parse(event.data);


      if (message.type === "participant_count") {

        setParticipantCount(message.count);

      }


      if (message.type === "location") {

        setFriendLocation({
          lat: message.lat,
          lng: message.lng,
          accuracy: message.accuracy,
        });

      }


      if (message.type === "participant_left") {

        setParticipantCount(
          (current) => Math.max(0, current - 1)
        );

        setFriendLocation(null);

      }

    };


    socket.onerror = (error) => {
      console.error("❌ WebSocket error:", error);
    };

    socket.onclose = (event) => {
      console.log(
        "🔌 WebSocket closed:",
        event.code,
        event.reason
      );
    };


    return () => {

      socket.close();

      stopLocationTracking();

    };

  }, [sessionId, participantId, participantToken]);


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


    watchIdRef.current =
      navigator.geolocation.watchPosition(

        (position) => {

          const location = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
          };

          setMyLocation(location);


          if (
            socketRef.current &&
            socketRef.current.readyState === WebSocket.OPEN
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

          console.error(error);

          setError(
            "Location permission is required to show the map."
          );

        },

        {
          enableHighAccuracy: true,
          maximumAge: 5000,
          timeout: 10000,
        }

      );

  }


  function stopLocationTracking() {

    if (watchIdRef.current !== null) {

      navigator.geolocation.clearWatch(
        watchIdRef.current
      );

      watchIdRef.current = null;

    }

  }


  // -------------------------------------------------------
  // Home
  // -------------------------------------------------------

  if (screen === "home") {

    return (
      <main className="app">

        <div className="card">

          <h1>SyncWalk</h1>

          <p>
            Walk together, even when you're apart.
          </p>


          <button onClick={createSession}>
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
  // Waiting screen
  // -------------------------------------------------------

  if (screen === "waiting") {

    return (
      <main className="app">

        <div className="card">

          <h1>Your session</h1>

          <p>
            Ask your friend to enter this code:
          </p>


          <div className="code">
            {sessionCode}
          </div>


          <p>
            Waiting for your friend...
          </p>


          <p>
            Connected: {participantCount}/2
          </p>

        </div>

      </main>
    );

  }


  // -------------------------------------------------------
  // Map
  // -------------------------------------------------------

  const defaultPosition =
    myLocation
      ? [myLocation.lat, myLocation.lng]
      : [20.5937, 78.9629];


  return (
    <main className="session">

      <header>

        <div>
          <strong>SyncWalk</strong>

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
            attribution='&copy; OpenStreetMap contributors'
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
                You 🚶
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
                Friend 🚴
              </Popup>

            </Marker>

          )}

        </MapContainer>

      </div>


      <div className="status">

        {myLocation
          ? "📍 Sharing your location"
          : "⏳ Waiting for location permission..."}


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