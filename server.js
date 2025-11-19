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

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "NO_TOKEN" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { uid, email }
    next();
  } catch (err) {
    return res.status(401).json({ error: "INVALID_TOKEN" });
  }
}

function authOptional(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) return next();

  try {
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
  } catch (err) {
    req.user = null;
  }

  next();
}

// --------------------------------------------------
// ROOT
// --------------------------------------------------
app.get("/", (req, res) => {
  res.send("CampTrack API Running ✔️");
});

app.get("/places", async (req, res) => {
  try {
    const snap = await db
      .collection("places")
      .orderBy("createdAt", "desc")
      .get();

    const places = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({ places });
  } catch (err) {
    console.error("PLACES LIST ERROR:", err);
    return res.status(500).json({ error: "PLACES_FETCH_FAILED" });
  }
});

app.get("/places/new", async (req, res) => {
  try {
    const snap = await db
      .collection("places")
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();

    const places = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({ places });
  } catch (err) {
    console.error("NEW PLACES ERROR:", err);
    return res.status(500).json({ error: "NEW_PLACES_FAILED" });
  }
});

app.get("/places/popular", async (req, res) => {
  try {
    const snap = await db
      .collection("places")
      .where("isPopular", "==", true)
      .get();

    const places = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({ places });
  } catch (err) {
    console.error("POPULAR FETCH ERROR:", err);
    return res.status(500).json({ error: "POPULAR_FETCH_FAILED" });
  }
});

app.get("/places/:id", authOptional, async (req, res) => {
  try {
    const { id } = req.params;

    const snap = await db.collection("places").doc(id).get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Place not found" });
    }

    const place = { id: snap.id, ...snap.data() };

    // favori kontrolü (kullanıcı giriş yaptıysa)
    if (req.user?.uid) {
      const favSnap = await db.collection("favorites").doc(req.user.uid).get();
      const isFav = favSnap.exists && favSnap.data()[id] === true;
      place.isFavorite = isFav;
    } else {
      place.isFavorite = false;
    }

    return res.json({ place });
  } catch (err) {
    console.error("Place fetch error:", err);
    res.status(500).json({ error: "Failed to fetch place" });
  }
});

// --------------------------------------------------
// REGISTER USER
// --------------------------------------------------

app.post("/register", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
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

app.post("/favorites/add", authMiddleware, async (req, res) => {
  try {
    const { placeId } = req.body;
    const userId = req.user.uid;

    if (!placeId) {
      return res.status(400).json({ error: "Missing placeId" });
    }

    await db
      .collection("favorites")
      .doc(userId)
      .set({ [placeId]: true }, { merge: true });

    return res.json({ success: true });
  } catch (err) {
    console.log("FAVORITE ADD ERROR:", err);
    return res.status(500).json({ error: "FAVORITE_ADD_FAILED" });
  }
});

app.post("/favorites/remove", authMiddleware, async (req, res) => {
  try {
    const { placeId } = req.body;
    const userId = req.user.uid;

    if (!placeId) {
      return res.status(400).json({ error: "Missing placeId" });
    }

    await db
      .collection("favorites")
      .doc(userId)
      .update({
        [placeId]: admin.firestore.FieldValue.delete(),
      });

    return res.json({ success: true });
  } catch (err) {
    console.log("FAVORITE REMOVE ERROR:", err);
    return res.status(500).json({ error: "FAVORITE_REMOVE_FAILED" });
  }
});

app.get("/favorites", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.uid;

    const snap = await db.collection("favorites").doc(userId).get();

    if (!snap.exists) {
      return res.json({ favorites: [] });
    }

    const favObj = snap.data(); // {placeId: true}
    const favIds = Object.keys(favObj);

    if (favIds.length === 0) {
      return res.json({ favorites: [] });
    }

    // Firestore’dan favori yerleri çek
    const placesRef = db.collection("places");
    const results = [];

    for (let id of favIds) {
      const p = await placesRef.doc(id).get();
      if (p.exists) {
        results.push({ id: p.id, ...p.data() });
      }
    }

    return res.json({ favorites: results });
  } catch (err) {
    console.log("FAVORITE LIST ERROR:", err);
    return res.status(500).json({ error: "FAVORITE_LIST_FAILED" });
  }
});

// --------------------------------------------------
// TEST PROTECTED ROUTE
// --------------------------------------------------
app.get("/auth/me", authMiddleware, async (req, res) => {
  try {
    const userSnap = await db.collection("users").doc(req.user.uid).get();

    if (!userSnap.exists) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    return res.json({
      user: userSnap.data(),
    });
  } catch (err) {
    return res.status(500).json({ error: "AUTH_FAILED" });
  }
});

// --------------------------------------------------------
// FAVORİ EKLE
// --------------------------------------------------------
app.post("/favorites/add", async (req, res) => {
  try {
    const { userId, placeId } = req.body;

    const placeRef = db.collection("places").doc(placeId);

    await placeRef.update({
      favoritedBy: admin.firestore.FieldValue.arrayUnion(userId),
    });

    return res.json({ success: true });
  } catch (err) {
    console.log("FAVORITE ADD ERROR:", err);
    return res.status(500).json({ error: "FAVORITE_ADD_FAILED" });
  }
});

// --------------------------------------------------------
// FAVORİ ÇIKAR
// --------------------------------------------------------
app.post("/favorites/remove", async (req, res) => {
  try {
    const { userId, placeId } = req.body;

    const placeRef = db.collection("places").doc(placeId);

    await placeRef.update({
      favoritedBy: admin.firestore.FieldValue.arrayRemove(userId),
    });

    return res.json({ success: true });
  } catch (err) {
    console.log("FAVORITE REMOVE ERROR:", err);
    return res.status(500).json({ error: "FAVORITE_REMOVE_FAILED" });
  }
});

// --------------------------------------------------------
// GET USER FAVORITES
// --------------------------------------------------------
app.get("/favorites/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const snapshot = await db
      .collection("places")
      .where("favoritedBy", "array-contains", userId)
      .get();

    const favorites = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({ favorites });
  } catch (err) {
    console.log("FAVORITE LIST ERROR:", err);
    res.status(500).json({ error: "FAVORITE_LIST_FAILED" });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
app.listen(process.env.PORT || 5000, () => {
  console.log("🔥 Backend running on port", process.env.PORT || 5000);
});
