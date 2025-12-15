// firebase.js
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const jsonPath =
  process.env.NODE_ENV === "production"
    ? "/etc/secrets/serviceAccountKey.json"
    : "./serviceAccountKey.json";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// service account yolu
const serviceAccountPath = path.join(__dirname, jsonPath);
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

// Firebase Admin başlat
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export const db = admin.firestore();
export const auth = admin.auth();
export default admin;
