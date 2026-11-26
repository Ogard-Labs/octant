import "./src/runtime/installCrypto";
import { registerRootComponent } from "expo";
import { Platform } from "react-native";
import App from "./src/App";
import { reclaimVideoClipCache } from "./src/surfaces/videoClipCache";

if (Platform.OS !== "web") reclaimVideoClipCache();

registerRootComponent(App);
