import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

if ("serviceWorker" in navigator)
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("/sw.js"),
  );
const target = document.getElementById("app");
if (!target) throw new Error("Missing app mount element");
mount(App, { target });
