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

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "NO_TOKEN" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
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

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");
}

const generateKeywords = (name) => {
  const low = name.toLowerCase();
  const keys = [];
  for (let i = 1; i <= low.length; i++) {
    keys.push(low.substring(0, i));
  }
  return keys;
};

app.post("/teams/create", async (req, res) => {
  try {
    const { userId, name } = req.body;
    if (!userId || !name) {
      return res.status(400).json({ error: "Missing userId or name" });
    }

    const teamRef = await db.collection("teams").add({
      name,
      ownerId: userId,
      createdAt: Date.now(),
      members: [userId],
    });

    return res.json({
      success: true,
      teamId: teamRef.id,
      name,
    });
  } catch (err) {
    console.log("TEAM_CREATE_ERROR:", err);
    return res.status(500).json({ error: "TEAM_CREATE_FAILED" });
  }
});

// 3) USER INVITE (add member)
app.post("/teams/invite", async (req, res) => {
  try {
    const { teamId, fromId, toId } = req.body;

    if (!teamId || !fromId || !toId) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    const teamSnap = await db.collection("teams").doc(teamId).get();
    if (!teamSnap.exists)
      return res.status(404).json({ error: "TEAM_NOT_FOUND" });

    const team = teamSnap.data();

    if (team.ownerId !== fromId)
      return res.status(403).json({ error: "NO_PERMISSION" });

    const fromUser = await db.collection("users").doc(fromId).get();
    const toUser = await db.collection("users").doc(toId).get();

    const requestId = Date.now().toString();

    await db.collection("teamRequests").doc(requestId).set({
      id: requestId,
      teamId,
      teamName: team.name,
      fromId,
      fromName: fromUser.data().name,
      toId,
      toName: toUser.data().name,
      createdAt: Date.now(),
    });

    return res.json({ success: true, requestId });
  } catch (err) {
    console.log("INVITE_ERROR:", err);
    res.status(500).json({ error: "INVITE_FAILED" });
  }
});

app.get("/teams/requests", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "MISSING_USER_ID" });

    const snap = await db
      .collection("teamRequests")
      .where("toId", "==", userId)
      .get();

    const requests = [];
    snap.forEach((doc) => requests.push(doc.data()));

    return res.json({ requests });
  } catch (err) {
    console.log("REQUEST_LIST_ERROR:", err);
    return res.status(500).json({ error: "REQUEST_LIST_FAILED" });
  }
});

app.post("/teams/request/reject", async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId)
      return res.status(400).json({ error: "MISSING_REQUEST_ID" });

    const reqSnap = await db.collection("teamRequests").doc(requestId).get();
    if (!reqSnap.exists)
      return res.status(404).json({ error: "REQUEST_NOT_FOUND" });

    await db.collection("teamRequests").doc(requestId).delete();

    return res.json({ success: true });
  } catch (err) {
    console.log("REQUEST_REJECT_ERROR:", err);
    return res.status(500).json({ error: "REQUEST_REJECT_FAILED" });
  }
});

app.post("/teams/requests/accept", async (req, res) => {
  try {
    const { requestId, teamId, userId } = req.body;

    if (!requestId || !teamId || !userId) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    // 1) Takıma kullanıcı ekle
    await db
      .collection("teams")
      .doc(teamId)
      .update({
        members: admin.firestore.FieldValue.arrayUnion(userId),
      });

    // 2) Kullanıcının myTeams listesine ekle
    await db
      .collection("userTeams")
      .doc(userId)
      .set({ [teamId]: true }, { merge: true });

    // 3) Request’i sil
    await db.collection("teamRequests").doc(requestId).delete();

    return res.json({ success: true });
  } catch (err) {
    console.log("REQUEST_ACCEPT_ERROR:", err);
    res.status(500).json({ error: "ACCEPT_FAILED" });
  }
});

// 3) Kullanıcının tüm takımlarını listele
app.get("/teams/my/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: "MISSING_USER_ID" });

    const snap = await db.collection("teams").get();

    const myTeams = [];
    snap.forEach((doc) => {
      const data = doc.data();
      if (data.members?.includes(userId)) {
        myTeams.push({ id: doc.id, ...data });
      }
    });

    return res.json({ teams: myTeams });
  } catch (err) {
    console.log("TEAMS_MY_ERROR:", err);
    return res.status(500).json({ error: "TEAMS_MY_FAILED" });
  }
});

app.get("/teams/:teamId", async (req, res) => {
  try {
    const { teamId } = req.params;
    console.log("/teams/:teamId", teamId);
    const snap = await db.collection("teams").doc(teamId).get();
    if (!snap.exists) {
      return res.status(404).json({ error: "TEAM_NOT_FOUND" });
    }

    const team = { id: teamId, ...snap.data() };

    return res.json({ team });
  } catch (err) {
    console.log("TEAM_DETAIL_ERROR:", err);
    res.status(500).json({ error: "TEAM_DETAIL_FAILED" });
  }
});

// TEAM MEMBERS – PUBLIC (token yok)
app.get("/teams/:teamId/members", async (req, res) => {
  try {
    const { teamId } = req.params;

    const snap = await db.collection("teams").doc(teamId).get();
    if (!snap.exists) return res.json({ members: [] });

    const team = snap.data();
    const memberIds = team.members || [];

    const members = [];

    for (let id of memberIds) {
      const userSnap = await db.collection("users").doc(id).get();
      if (userSnap.exists) {
        members.push({ id, ...userSnap.data() });
      }
    }

    return res.json({ members });
  } catch (err) {
    console.log("TEAM_MEMBERS_ERROR:", err);
    res.status(500).json({ error: "TEAM_MEMBERS_FAILED" });
  }
});

// ADD MEMBER – Only owner can add (token yok → body üzerinden ownerId)
app.post("/teams/addMember", async (req, res) => {
  try {
    const { teamId, userId, ownerId } = req.body;

    if (!teamId || !userId || !ownerId) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    // Team getir
    const teamSnap = await db.collection("teams").doc(teamId).get();
    if (!teamSnap.exists)
      return res.status(404).json({ error: "TEAM_NOT_FOUND" });

    const team = teamSnap.data();

    // 🔥 SADECE takım sahibi ekleme yapabilir
    if (team.ownerId !== ownerId)
      return res.status(403).json({ error: "NO_PERMISSION" });

    // Mevcut üyeler
    const members = team.members || [];

    // Zaten ekli mi?
    if (!members.includes(userId)) {
      members.push(userId);
    }

    // Firestore'a yaz
    await db.collection("teams").doc(teamId).update({
      members: members,
    });

    // Kullanıcıya da ekle
    await db
      .collection("userTeams")
      .doc(userId)
      .set({ [teamId]: true }, { merge: true });

    return res.json({ success: true });
  } catch (err) {
    console.log("ADD_MEMBER_ERROR:", err);
    res.status(500).json({ error: "ADD_MEMBER_FAILED" });
  }
});

// ---------------------------------------------------------
// TAKIM ADINI DEĞİŞTİRME (YALNIZCA TAKIM SAHİBİ)
// ---------------------------------------------------------
app.post("/teams/rename", async (req, res) => {
  try {
    const userId = req.user.uid;
    const { teamId, newName } = req.body;

    const snap = await db.collection("teams").doc(teamId).get();
    if (!snap.exists) return res.status(404).json({ error: "TEAM_NOT_FOUND" });

    const team = snap.data();

    // Yalnızca sahibi değiştirebilir
    if (team.ownerId !== userId)
      return res.status(403).json({ error: "NO_PERMISSION" });

    await db.collection("teams").doc(teamId).update({
      name: newName,
    });

    return res.json({ success: true, newName });
  } catch (err) {
    console.log("TEAM_RENAME_ERROR:", err);
    res.status(500).json({ error: "TEAM_RENAME_FAILED" });
  }
});

app.get("/teams/:teamId/members", async (req, res) => {
  try {
    const { teamId } = req.params;

    const teamSnap = await db.collection("teams").doc(teamId).get();
    if (!teamSnap.exists)
      return res.status(404).json({ error: "TEAM_NOT_FOUND" });

    const team = teamSnap.data();
    const members = team.members || [];

    const userList = [];
    for (let uid of members) {
      const userSnap = await db.collection("users").doc(uid).get();
      if (userSnap.exists) {
        userList.push({ id: uid, ...userSnap.data() });
      }
    }

    return res.json({ members: userList });
  } catch (err) {
    console.log("TEAM_MEMBERS_ERROR:", err);
    res.status(500).json({ error: "TEAM_MEMBERS_FAILED" });
  }
});

app.post("/users/setOnline", async (req, res) => {
  try {
    const { userId, isOnline } = req.body;

    if (!userId) return res.status(400).json({ error: "NO_USER_ID" });

    await db.collection("users").doc(userId).update({
      isOnline,
      lastSeen: Date.now(),
    });

    return res.json({ success: true });
  } catch (err) {
    console.log("ONLINE_UPDATE_ERROR:", err);
    res.status(500).json({ error: "ONLINE_UPDATE_FAILED" });
  }
});

app.get("/users/search", async (req, res) => {
  try {
    const { username } = req.query;

    if (!username || username.length < 3) {
      return res.json({ users: [] });
    }

    const low = username.toLowerCase();

    const snap = await db
      .collection("users")
      .where("keywords", "array-contains", low)
      .get();

    const users = [];
    snap.forEach((doc) => users.push({ id: doc.id, ...doc.data() }));

    return res.json({ users });
  } catch (err) {
    console.log("SEARCH_USERS_ERROR:", err);
    res.status(500).json({ error: "SEARCH_FAILED" });
  }
});

app.get("/places/search", async (req, res) => {
  const q = normalize(req.query.query || "");

  const snap = await db.collection("places").get();

  const results = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter(
      (p) => normalize(p.name).includes(q) || normalize(p.city).includes(q)
    );

  res.json({ places: results });
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

app.post("/places/add", async (req, res) => {
  try {
    const { userId, name, city, description, photos, location } = req.body;
    // --- VALIDATION ---
    if (
      !userId ||
      !name ||
      !city ||
      !photos ||
      !Array.isArray(photos) ||
      photos.length === 0 ||
      !location?.latitude ||
      !location?.longitude
    ) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    // --- USER CHECK ---
    const userSnap = await db.collection("users").doc(userId).get();

    if (!userSnap.exists) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    const user = userSnap.data();

    // --- ADMIN / USER ---
    const addedBy = user.role === "admin" ? "admin" : userId;

    // --- SAVE PLACE ---
    const placeRef = await db.collection("places").add({
      name,
      city,
      description: description || "",
      photos, // Array of base64 strings or URLs
      createdAt: Date.now(),
      addedBy,
      latitude: location.latitude,
      longitude: location.longitude,
    });

    return res.json({
      success: true,
      id: placeRef.id,
      addedBy,
    });
  } catch (err) {
    console.log("❌ PLACE_ADD_ERROR:", err);
    return res.status(500).json({ error: "PLACE_ADD_FAILED" });
  }
});

app.get("/places/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // Kullanıcıyı çek
    const userSnap = await db.collection("users").doc(userId).get();
    if (!userSnap.exists) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    const user = userSnap.data();

    let snap;

    if (user.role === "admin") {
      // Adminse → addedBy == "admin" olanları getir
      snap = await db
        .collection("places")
        .where("addedBy", "==", "admin")
        .orderBy("createdAt", "desc")
        .get();
    } else {
      // Normal kullanıcıysa → addedBy == userId
      snap = await db
        .collection("places")
        .where("addedBy", "==", userId)
        .orderBy("createdAt", "desc")
        .get();
    }

    const places = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({ places });
  } catch (err) {
    console.log("USER_PLACES_ERROR:", err);
    res.status(500).json({ error: "USER_PLACES_FAILED" });
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
    const { userId } = req.query; // ← USERİD BURADA GELİYOR

    const snap = await db.collection("places").doc(id).get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Place not found" });
    }

    const place = { id: snap.id, ...snap.data() };

    // Eğer userId varsa favori kontrolünü yap

    if (userId) {
      const favSnap = await db.collection("favorites").doc(userId).get();
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
    let { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    // nickname orijinal kalır → sadece arama için lowercase çıkarılır
    const keywords = name.toLowerCase();

    // Nickname var mı? (case-insensitive kontrol)
    const nickCheck = await db
      .collection("users")
      .where("keywords", "==", keywords)
      .get();

    if (!nickCheck.empty) {
      return res.status(400).json({ error: "NICKNAME_EXISTS" });
    }

    // Email var mı?
    const emailCheck = await db
      .collection("users")
      .where("email", "==", email)
      .get();

    if (!emailCheck.empty) {
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
        name, // orijinal isim
        keywords: generateKeywords(name), // küçük harfli arama
        email,
        phone,
        image: `https://ui-avatars.com/api/?name=${name}`,
        createdAt: Date.now(),
        role: "user",
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

app.post("/favorites/add", async (req, res) => {
  try {
    const { userId, placeId } = req.body;

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

app.post("/favorites/remove", async (req, res) => {
  try {
    const { userId, placeId } = req.body;

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

app.get("/favorites", async (req, res) => {
  try {
    const { userId } = req.query;

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

// 📌 Bir kullanıcıya davet gönder
app.post("/notifications/send", async (req, res) => {
  try {
    const { fromUserId, toUserId, teamId, teamName } = req.body;
    console.log("/notifications/send", fromUserId, toUserId, teamId, teamName);
    if (!fromUserId || !toUserId || !teamId) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    const notifId = Date.now().toString();

    await db.collection("notifications").doc(notifId).set({
      id: notifId,
      fromUserId,
      toUserId,
      teamId,
      teamName,
      type: "team_invite",
      createdAt: Date.now(),
      seen: false,
    });

    return res.json({ success: true, notifId });
  } catch (err) {
    console.log("NOTIFICATIONS_SEND_ERROR:", err);
    res.status(500).json({ error: "NOTIFICATION_SEND_FAILED" });
  }
});

// 📌 Bildirimleri listele
app.get("/notifications/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const snap = await db
      .collection("notifications")
      .where("toUserId", "==", userId)
      .orderBy("createdAt", "desc")
      .get();

    const list = [];
    snap.forEach((d) => list.push(d.data()));

    return res.json({ notifications: list });
  } catch (err) {
    console.log("NOTIFICATIONS_GET_ERROR:", err);
    res.status(500).json({ error: "NOTIFICATIONS_FETCH_FAILED" });
  }
});

// 📌 Daveti kabul et → kullanıcıyı takıma ekle
app.post("/notifications/accept", async (req, res) => {
  try {
    const { notifId, userId } = req.body;
    if (!notifId || !userId)
      return res.status(400).json({ error: "MISSING_FIELDS" });

    const notifSnap = await db.collection("notifications").doc(notifId).get();
    if (!notifSnap.exists)
      return res.status(404).json({ error: "NOTIFICATION_NOT_FOUND" });

    const notif = notifSnap.data();

    // Takıma ekle
    const teamSnap = await db.collection("teams").doc(notif.teamId).get();
    if (!teamSnap.exists)
      return res.status(404).json({ error: "TEAM_NOT_FOUND" });

    const team = teamSnap.data();
    const members = team.members || [];

    if (!members.includes(userId)) members.push(userId);

    await db.collection("teams").doc(notif.teamId).update({ members });

    // userTeams güncelle
    await db
      .collection("userTeams")
      .doc(userId)
      .set({ [notif.teamId]: true }, { merge: true });

    // Bildirimi sil
    await db.collection("notifications").doc(notifId).delete();

    return res.json({ success: true });
  } catch (err) {
    console.log("NOTIFICATION_ACCEPT_ERROR:", err);
    res.status(500).json({ error: "NOTIFICATION_ACCEPT_FAILED" });
  }
});

app.post("/notifications/reject", async (req, res) => {
  try {
    const { notifId } = req.body;
    console.log("/notifications/reject", notifId);
    if (!notifId) return res.status(400).json({ error: "MISSING_FIELDS" });

    await db.collection("notifications").doc(notifId).delete();

    return res.json({ success: true });
  } catch (err) {
    console.log("NOTIFICATION_REJECT_ERROR:", err);
    res.status(500).json({ error: "NOTIFICATION_REJECT_FAILED" });
  }
});

app.get("/backpack/:userId", async (req, res) => {
  const { userId } = req.params;
  console.log(userId);
  try {
    const ref = db.collection("backpacks").doc(userId);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.json({ items: [] });
    }

    return res.json({ items: snap.data().items || [] });
  } catch (err) {
    console.log("BACKPACK_GET_ERROR:", err);
    res.status(500).json({ error: "BACKPACK_GET_FAILED" });
  }
});

app.post("/backpack/add", async (req, res) => {
  const { userId, item } = req.body;
  console.log("add", userId, item);
  if (!userId || !item?.id) {
    return res.status(400).json({ error: "MISSING_FIELDS" });
  }

  const ref = db.collection("backpacks").doc(userId);

  try {
    await db.runTransaction(async (t) => {
      const snap = await t.get(ref);

      const current = snap.exists ? snap.data().items || [] : [];

      // Eğer aynı eşya varsa tekrar ekleme
      if (!current.some((i) => i.id === item.id)) {
        current.push(item);
      }

      t.set(ref, { items: current }, { merge: true });
    });

    res.json({ success: true });
  } catch (err) {
    console.log("BACKPACK_ADD_ERROR:", err);
    res.status(500).json({ error: "BACKPACK_ADD_FAILED" });
  }
});

app.post("/backpack/remove", async (req, res) => {
  const { userId, itemId } = req.body;
  console.log("remove", userId, itemId);
  if (!userId || !itemId) {
    return res.status(400).json({ error: "MISSING_FIELDS" });
  }

  const ref = db.collection("backpacks").doc(userId);

  try {
    await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return;

      const current = snap.data().items || [];
      const updated = current.filter((i) => i.id !== itemId);

      t.set(ref, { items: updated }, { merge: true });
    });

    res.json({ success: true });
  } catch (err) {
    console.log("BACKPACK_REMOVE_ERROR:", err);
    res.status(500).json({ error: "BACKPACK_REMOVE_FAILED" });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
app.listen(process.env.PORT || 5000, () => {
  console.log("🔥 Backend running on port", process.env.PORT || 5000);
});
