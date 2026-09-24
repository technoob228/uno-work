import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./proto.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
