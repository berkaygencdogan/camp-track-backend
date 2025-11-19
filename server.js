import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// -----------------------------
// FIREBASE ADMIN BAŞLAT
// -----------------------------
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

// -----------------------------
// JWT USER MIDDLEWARE
// -----------------------------
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "No token" });

  try {
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { uid, email }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// -----------------------------
// KULLANICI OLUŞTURMA
// -----------------------------
app.post("/auth/register", async (req, res) => {
  try {
    const { name, username, email, password } = req.body;

    const exists = await db
      .collection("users")
      .where("email", "==", email)
      .get();

    if (!exists.empty) return res.status(400).json({ error: "Email exists" });

    const cred = await admin.auth().createUser({
      email,
      password,
      displayName: name,
    });

    await db
      .collection("users")
      .doc(cred.uid)
      .set({
        id: cred.uid,
        name,
        username,
        email,
        image: "https://ui-avatars.com/api/?name=" + name,
        role: "Scout",
        createdAt: Date.now(),
      });

    return res.json({ success: true });
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: "Register failed" });
  }
});

// -----------------------------
// LOGIN
// -----------------------------
app.post("/auth/login", async (req, res) => {
  try {
    const { email } = req.body;

    const user = await db.collection("users").where("email", "==", email).get();

    if (user.empty) return res.status(404).json({ error: "User not found" });

    const userData = user.docs[0].data();

    const token = jwt.sign(
      { uid: userData.id, email: userData.email },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.json({
      token,
      user: userData,
    });
  } catch (e) {
    res.status(500).json({ error: "Login failed" });
  }
});

// --------------------------------------------------------
// USERNAME ARAMA (Add Teammates ekranında kullanılır)
// --------------------------------------------------------
app.get("/users/search", auth, async (req, res) => {
  try {
    const username = req.query.username?.toLowerCase();

    if (!username || username.length < 2) return res.json({ results: [] });

    const usersRef = await db.collection("users").get();

    const results = usersRef.docs
      .map((d) => d.data())
      .filter(
        (u) =>
          u.username &&
          u.username.toLowerCase().includes(username) &&
          u.id !== req.user.uid
      );

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: "Search failed" });
  }
});

app.get("/places/search", async (req, res) => {
  try {
    const queryText = (req.query.query || "").toLowerCase();

    if (!queryText.trim()) {
      return res.json({ places: [] });
    }

    // Firestore'dan tüm yerleri çek
    const snapshot = await db.collection("places").get();

    const places = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Substring search
    const filtered = places.filter(
      (p) =>
        p.name.toLowerCase().includes(queryText) ||
        p.city.toLowerCase().includes(queryText)
    );

    res.json({ places: filtered });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

app.get("/places/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const docRef = db.collection("places").doc(id);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Place not found" });
    }

    return res.json({
      place: {
        id: snap.id,
        ...snap.data(),
      },
    });
  } catch (err) {
    console.error("Place fetch error:", err);
    res.status(500).json({ error: "Failed to fetch place" });
  }
});

// --------------------------------------------------------
// DAVET GÖNDER
// --------------------------------------------------------
app.post("/teammates/request", auth, async (req, res) => {
  try {
    const { to } = req.body;

    if (!to) return res.status(400).json({ error: "Missing user id" });

    await db.collection("teammate_requests").add({
      from: req.user.uid,
      to,
      createdAt: Date.now(),
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Request failed" });
  }
});

// ===============================
// 📌 ADD NEW PLACE (base64 upload)
// ===============================
app.post("/places/add", async (req, res) => {
  try {
    const { name, city, description, photos } = req.body;

    if (!name || !city || !description || !photos || photos.length === 0) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // -----------------------------
    // KEYWORD GENERATOR
    // -----------------------------
    function generateKeywords(str) {
      const base = str.toLowerCase().replace(/[^a-zA-ZğüşöçıİĞÜŞÖÇ ]/g, "");

      const words = base.split(" ").filter((w) => w.length > 0);
      const set = new Set();

      words.forEach((w) => {
        set.add(w);
        for (let i = 1; i <= w.length; i++) set.add(w.substring(0, i));
      });

      // 3000 keyword limit (Firestore için ideal)
      return [...set].slice(0, 3000);
    }

    const keywordBase = `${name} ${city} ${description}`;
    const searchKeywords = generateKeywords(keywordBase);

    // -----------------------------
    // STORAGE UPLOAD (MULTI)
    // -----------------------------
    const bucket = admin.storage().bucket();
    const photoUrls = [];

    for (const img of photos) {
      const buffer = Buffer.from(
        img.replace(/^data:image\/\w+;base64,/, ""),
        "base64"
      );

      const fileId =
        Date.now().toString() + "-" + Math.random().toString(36).slice(2);
      const file = bucket.file(`places/${fileId}.jpg`);

      await file.save(buffer, {
        metadata: { contentType: "image/jpeg" },
        public: true,
      });

      const url = `https://storage.googleapis.com/${
        bucket.name
      }/${encodeURIComponent(`places/${fileId}.jpg`)}`;

      photoUrls.push(url);
    }

    // -----------------------------
    // FIRESTORE SAVE
    // -----------------------------
    const placeId = Date.now().toString();

    await db.collection("places").doc(placeId).set({
      name,
      city,
      description,
      photos: photoUrls,
      searchKeywords,
      rating: 0,
      isPopular: false,
      createdAt: new Date(),
    });

    return res.json({
      success: true,
      id: placeId,
      photos: photoUrls,
    });
  } catch (err) {
    console.error("ADD PLACE ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// --------------------------------------------------------
// BEKLEYEN DAVETLER (BİLDİRİM BUTONUNA GELECEK)
// --------------------------------------------------------
app.get("/teammates/requests", auth, async (req, res) => {
  try {
    const snap = await db
      .collection("teammate_requests")
      .where("to", "==", req.user.uid)
      .get();

    let requests = [];

    for (let doc of snap.docs) {
      const data = doc.data();
      const fromUser = await db.collection("users").doc(data.from).get();

      requests.push({
        id: doc.id,
        user: fromUser.data(),
      });
    }

    res.json({ requests });
  } catch (e) {
    res.status(500).json({ error: "List failed" });
  }
});

// --------------------------------------------------------
// KABUL ET
// --------------------------------------------------------
app.post("/teammates/accept", auth, async (req, res) => {
  try {
    const { requestId, otherUserId } = req.body;

    // karşılıklı ekleme
    await db.collection("teammates").add({
      userId: req.user.uid,
      teammateId: otherUserId,
    });

    await db.collection("teammates").add({
      userId: otherUserId,
      teammateId: req.user.uid,
    });

    // request sil
    await db.collection("teammate_requests").doc(requestId).delete();

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Accept failed" });
  }
});

// --------------------------------------------------------
// REDDET
// --------------------------------------------------------
app.post("/teammates/reject", auth, async (req, res) => {
  try {
    const { requestId } = req.body;

    await db.collection("teammate_requests").doc(requestId).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Reject failed" });
  }
});

// --------------------------------------------------------
// TEAMMATES LİSTESİ
// --------------------------------------------------------
app.get("/teammates", auth, async (req, res) => {
  try {
    const { uid } = req.user;

    const snap = await db
      .collection("teammates")
      .where("userId", "==", uid)
      .get();

    let teammates = [];

    for (let doc of snap.docs) {
      const partner = await db
        .collection("users")
        .doc(doc.data().teammateId)
        .get();

      teammates.push(partner.data());
    }

    const you = (await db.collection("users").doc(uid).get()).data();

    res.json({ teammates, you });
  } catch (e) {
    res.status(500).json({ error: "List failed" });
  }
});

// START
app.listen(process.env.PORT, () =>
  console.log("🔥 Backend running on port " + process.env.PORT)
);
