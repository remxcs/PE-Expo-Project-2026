import { useState } from "react";
import "./App.css";

export default function App() {
  const [answer, setAnswer] = useState(null);
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();

  function saveAnswer(choice) {
    setAnswer(choice);

    const data = {
      answer: choice,
      time: new Date().toISOString()
    };

    const blob = new Blob(
      [JSON.stringify(data, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "answer.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="container">
      <h1>Pick one</h1>

      <div className="buttons">
        <button onClick={() => saveAnswer("A")}>A</button>
        <button onClick={() => saveAnswer("B")}>B</button>
        <button onClick={() => saveAnswer("C")}>C</button>
        <button onClick={() => saveAnswer("D")}>D</button>
      </div>

      {answer && <p>Selected: {answer}</p>}
      <p>
        API health endpoint: {apiBaseUrl ? `${apiBaseUrl}/health` : "set VITE_API_BASE_URL to connect the backend scaffold"}
      </p>
    </div>
  );
}
