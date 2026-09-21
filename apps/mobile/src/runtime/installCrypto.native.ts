import { install } from "react-native-quick-crypto";

// Pairing and request proofs use WebCrypto, which Hermes does not provide.
// Install before loading the app so restored SecureStore keys can be imported.
install();
