const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();
console.log("API KEY:", process.env.FIREBASE_API_KEY);

// --------------------------------------------------
// JWT MIDDLEWARE
// --------------------------------------------------
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "NO_TOKEN" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: "INVALID_TOKEN" });
  }
}

// --------------------------------------------------
// ROOT
// --------------------------------------------------
app.get("/", (req, res) => {
  res.send("CampTrack API Running ✔️");
});

// --------------------------------------------------
// REGISTER USER
// --------------------------------------------------
app.post("/register", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    console.log(name, email, phone, password);
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    // Email zaten var mı?
    const exists = await db
      .collection("users")
      .where("email", "==", email)
      .get();
    if (!exists.empty) {
      return res.status(400).json({ error: "EMAIL_EXISTS" });
    }

    // Firebase Auth kullanıcı oluştur
    const cred = await admin.auth().createUser({
      email,
      password,
      displayName: name,
    });
    console.log("Created UID", cred.uid);

    // Firestore kayıt
    await db
      .collection("users")
      .doc(cred.uid)
      .set({
        id: cred.uid,
        name,
        email,
        phone,
        image: `https://ui-avatars.com/api/?name=${name}`,
        createdAt: Date.now(),
      });

    return res.json({ success: true });
  } catch (err) {
    console.log("REGISTER ERROR:", err);

    if (err.errorInfo?.code === "auth/email-already-exists") {
      return res.status(400).json({ error: "EMAIL_EXISTS" });
    }

    return res.status(500).json({ error: "REGISTER_FAILED" });
  }
});

// --------------------------------------------------
// LOGIN
// --------------------------------------------------
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: "MISSING_FIELDS" });

    const url =
      "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" +
      process.env.FIREBASE_API_KEY;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    });

    const data = await r.json();
    console.log("LOGIN RESPONSE:", data);

    if (data.error) {
      return res.status(400).json({ error: "INVALID_CREDENTIALS" });
    }

    const token = jwt.sign(
      { uid: data.localId, email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      success: true,
      token,
      uid: data.localId,
    });
  } catch (err) {
    console.log("LOGIN ERROR:", err);
    return res.status(500).json({ error: "LOGIN_FAILED" });
  }
});

// --------------------------------------------------
// TEST PROTECTED ROUTE
// --------------------------------------------------
app.get("/me", auth, async (req, res) => {
  try {
    const snap = await db.collection("users").doc(req.user.uid).get();
    return res.json({ user: snap.data() });
  } catch (err) {
    res.status(500).json({ error: "FAILED" });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
app.listen(process.env.PORT || 5000, () => {
  console.log("🔥 Backend running on port", process.env.PORT || 5000);
});
