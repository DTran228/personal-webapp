import { useState, useEffect } from "react";

function App() {

  const [health, setHealth] = useState<string>("loading...");

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => setHealth(data.status))
      .catch(() => setHealth("cannot reach backend"));
  }, []);

  return (
    <div>
      <h1>Finance Tracker</h1>
      <p>Backend status: {health}</p>
    </div>
  )
}

export default App;