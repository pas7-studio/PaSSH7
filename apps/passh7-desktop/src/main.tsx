import React from "react";
import {createRoot} from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./reference-ui.css";

const root=createRoot(document.getElementById("root")!);
// Deterministic UI fixtures exist only in Vite's development build.
// The production executable always mounts the real authenticated app.
if(import.meta.env.DEV&&new URLSearchParams(window.location.search).get("__reference")==="1"){
  void import("./ReferenceScreens").then(({default:ReferenceScreens})=>{
    root.render(<React.StrictMode><ReferenceScreens/></React.StrictMode>);
  });
}else{
  root.render(<React.StrictMode><App/></React.StrictMode>);
}
