const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const { v4: uuidv4 } = require("uuid");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
  storeBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

const db = admin.firestore();

const admins = ["Z6CGz9EtV0TKcMjiyClotxFUy9J3", "adminUid2", "adminUid3"];

async function getUsersMap(userIds) {
  if (!userIds || userIds.length === 0) return {};

  const map = {};

  // Firebase aynı anda birkaç doc'u getirebilir
  const promises = userIds.map((uid) => db.collection("users").doc(uid).get());

  const results = await Promise.all(promises);

  results.forEach((doc) => {
    if (doc.exists) {
      const data = doc.data();
      map[data.id] = {
        name: data.name || "Unknown",
        avatar: data.avatar || null,
      };
    }
  });

  return map;
}

async function checkAdmin(req, res, next) {
  try {
    const uid = req.query.uid;
    if (!uid) {
      return res
        .status(403)
        .json({ success: false, error: "Admin ID gerekli" });
    }

    if (!admins.includes(uid)) {
      return res
        .status(403)
        .json({ success: false, error: "Admin yetkisi yok" });
    }

    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists)
      return res
        .status(404)
        .json({ success: false, error: "Kullanıcı bulunamadı." });

    const user = userSnap.data();
    if (user.role !== "admin")
      return res
        .status(403)
        .json({ success: false, error: "Admin yetkisi yok." });

    req.admin = user;
    next();
  } catch (err) {
    console.log("Admin middleware error:", err);
    return res.status(500).json({ success: false, error: "Server hatası." });
  }
}

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

function createNotification({
  toUserId,
  fromUserId,
  type,
  teamId,
  teamName,
  teamLogo,
}) {
  return {
    id: Date.now().toString(),
    toUserId,
    fromUserId,
    type,
    teamId,
    teamName: teamName || "",
    teamLogo: teamLogo || "",
    createdAt: Date.now(),
    seen: false,
  };
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
    const { teamName, logo, createdBy } = req.body;

    if (!teamName || !createdBy) {
      return res.json({ success: false, error: "Eksik alanlar var." });
    }

    const teamId = Date.now().toString();

    // -------------------------------------------------------------------
    // 1) TAKIM LOGO YÜKLEME
    // -------------------------------------------------------------------
    let logoUrl = null;

    if (logo) {
      const buffer = Buffer.from(logo, "base64");
      const fileName = `teamLogos/${teamId}.jpg`;

      const bucket = admin
        .storage()
        .bucket(process.env.FIREBASE_STORAGE_BUCKET);
      const file = bucket.file(fileName);

      // 1) Dosyayı yükle
      await file.save(buffer, {
        metadata: { contentType: "image/jpeg" },
        public: true, // optional
      });

      // 2) Public yap
      await file.makePublic();

      // 3) Doğru public URL
      logoUrl = `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/${fileName}`;
    }

    // -------------------------------------------------------------------
    // 2) FIRESTORE TAKIM KAYDI
    // -------------------------------------------------------------------
    const teamData = {
      id: teamId,
      teamName,
      logo: logoUrl,
      createdAt: new Date(),
      members: [createdBy], // ✅ İlk üye -> takım sahibi
    };

    await db.collection("teams").doc(teamId).set(teamData);

    return res.json({ success: true, teamId, team: teamData });
  } catch (err) {
    console.log("TEAM CREATE ERROR:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 3) USER INVITE (add member)
app.post("/teams/invite", async (req, res) => {
  try {
    const { fromId, toId, teamId } = req.body;

    if (!teamId || !fromId || !toId) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    const teamSnap = await db.collection("teams").doc(toId).get();

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
      teamName: team.teamName,
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
    const userId = req.params.userId;

    // Üyesi olduğun takımları getir
    const snapshot = await db
      .collection("teams")
      .where("members", "array-contains", userId)
      .get();

    const teams = [];

    for (const doc of snapshot.docs) {
      const team = doc.data();

      // userMap için her üyeyi çek
      const userMap = await getUsersMap(team.members);

      teams.push({
        id: team.id,
        teamName: team.teamName,
        logo: team.logo || null,
        members: team.members || [],
        userMap, // avatar + isim eklenmiş şekilde
        createdAt: team.createdAt,
      });
    }

    return res.json({ success: true, teams });
  } catch (err) {
    console.log("TEAMS MY ERROR:", err);
    return res.json({
      success: false,
      error: err.message,
    });
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

// --------------------------------------------------
// REGISTER USER (FINAL VERSION)
// --------------------------------------------------
app.post("/register", async (req, res) => {
  try {
    let { name, email, phone, password } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    // nickname orijinal kalır → sadece arama için lowercase çıkarılır
    const keywords = generateKeywords(name);

    // Nickname var mı? (case-insensitive kontrol)
    const nickCheck = await db
      .collection("users")
      .where("keywords", "array-contains", keywords[0])
      .get();

    if (!nickCheck.empty) {
      const found = nickCheck.docs.some(
        (doc) => doc.data().name.toLowerCase() === name.toLowerCase()
      );
      if (found) {
        return res.status(400).json({ error: "NICKNAME_EXISTS" });
      }
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

    // 🔥 Firestore kullanıcı kaydı (GÜNCEL TAM ALANLAR)
    await db
      .collection("users")
      .doc(cred.uid)
      .set({
        id: cred.uid,
        name,
        email,
        phone,
        image: `https://ui-avatars.com/api/?name=${name}`,

        // 🔥 Arama için keyword'ler
        keywords,

        // 🔥 Sistem alanları
        role: "user",
        createdAt: Date.now(),

        // 🔥 Ban yapısı
        banExpiresAt: 0,
        banType: "none",
        banUntil: 0,

        // 🔥 Online tracking
        isOnline: false,
        lastSeen: Date.now(),
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

    const notifSnap = await db
      .collection("notifications")
      .where("toUserId", "==", userId)
      .orderBy("createdAt", "desc")
      .get();

    const notifications = [];

    for (const doc of notifSnap.docs) {
      const data = doc.data();

      // Gönderen kişinin avatar + isim
      const sender = await db.collection("users").doc(data.fromUserId).get();
      const senderInfo = sender.exists ? sender.data() : {};

      notifications.push({
        ...data,
        fromName: senderInfo.name || "",
        fromAvatar: senderInfo.avatar || "",
      });
    }

    return res.json({ success: true, notifications });
  } catch (err) {
    console.log("NOTIFICATION LIST ERROR:", err);
    return res.json({ success: false });
  }
});

// 📌 Daveti kabul et → kullanıcıyı takıma ekle
app.post("/notifications/accept", async (req, res) => {
  try {
    const { notifId, userId } = req.body;

    const notifRef = db.collection("notifications").doc(notifId);
    const notifSnap = await notifRef.get();

    if (!notifSnap.exists)
      return res.json({ success: false, msg: "Notification not found" });

    const notif = notifSnap.data();

    // 1 — Takıma kişi ekleniyor
    const teamRef = db.collection("teams").doc(notif.teamId);
    const teamSnap = await teamRef.get();
    const teamData = teamSnap.data();

    await teamRef.update({
      members: [...teamData.members, userId],
    });

    // Takım logosu al
    const teamLogo = teamData.teamLogo || "";

    // 2 — Daveti ACCEPT eden kişinin bilgileri
    const userRef = await db.collection("users").doc(userId).get();
    const userInfo = userRef.data();

    // 3 — Yeni bildirim oluştur → İsteği atan kişiye gidiyor
    const newNotif = createNotification({
      toUserId: notif.fromUserId,
      fromUserId: userId,
      type: "team_invite_accept",
      teamId: notif.teamId,
      teamName: notif.teamName,
      teamLogo,
    });

    await db.collection("notifications").doc(newNotif.id).set(newNotif);

    // 4 — Eski daveti sil
    await notifRef.delete();

    return res.json({ success: true });
  } catch (err) {
    console.log("ACCEPT ERROR:", err);
    return res.json({ success: false });
  }
});

app.post("/notifications/reject", async (req, res) => {
  try {
    const { notifId } = req.body;

    const notifRef = db.collection("notifications").doc(notifId);
    const notifSnap = await notifRef.get();

    if (!notifSnap.exists)
      return res.json({ success: false, msg: "Notification not found" });

    const notif = notifSnap.data();

    // Takım bilgilerini çek
    const teamRef = db.collection("teams").doc(notif.teamId);
    const teamSnap = await teamRef.get();
    const teamData = teamSnap.data();
    const teamLogo = teamData.teamLogo || "";

    // RED bildirimini oluştur
    const newNotif = createNotification({
      toUserId: notif.fromUserId, // → daveti atan
      fromUserId: notif.toUserId, // → reddeden kişi
      type: "team_invite_reject",
      teamId: notif.teamId,
      teamName: notif.teamName,
      teamLogo,
    });

    await db.collection("notifications").doc(newNotif.id).set(newNotif);

    // Eski daveti sil
    await notifRef.delete();

    return res.json({ success: true });
  } catch (err) {
    console.log("REJECT ERROR:", err);
    return res.json({ success: false });
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

app.post("/comments/add", async (req, res) => {
  const { placeId, userId, name, avatar, comment } = req.body;

  if (!placeId || !userId || !comment) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }

  const placeRef = admin.firestore().collection("places").doc(placeId);
  const snap = await placeRef.get();

  if (!snap.exists) return res.status(404).json({ success: false });

  const newComment = {
    id: uuidv4(),
    userId,
    name,
    avatar,
    comment,
    createdAt: Date.now(),
    likes: [],
    replies: [],
  };

  await placeRef.update({
    comments: admin.firestore.FieldValue.arrayUnion(newComment),
  });

  res.json({ success: true, comment: newComment });
});

app.post("/comments/edit", async (req, res) => {
  const { placeId, commentId, userId, newText } = req.body;

  const placeRef = admin.firestore().collection("places").doc(placeId);
  const snap = await placeRef.get();

  if (!snap.exists) return res.json({ success: false });

  const comments = snap.data().comments || [];

  const updatedList = comments.map((item) =>
    item.id === commentId && item.userId === userId
      ? { ...item, comment: newText }
      : item
  );

  await placeRef.update({ comments: updatedList });

  res.json({ success: true });
});

app.post("/comments/delete", async (req, res) => {
  const { placeId, commentId, userId } = req.body;

  const placeRef = admin.firestore().collection("places").doc(placeId);
  const snap = await placeRef.get();

  if (!snap.exists) return res.json({ success: false });

  const comments = snap.data().comments || [];

  const filtered = comments.filter(
    (item) => !(item.id === commentId && item.userId === userId)
  );

  await placeRef.update({ comments: filtered });

  res.json({ success: true });
});

app.post("/comments/like", async (req, res) => {
  const { placeId, commentId, userId } = req.body;

  const placeRef = admin.firestore().collection("places").doc(placeId);
  const snap = await placeRef.get();

  const comments = snap.data().comments || [];

  const updated = comments.map((item) => {
    if (item.id !== commentId) return item;

    const liked = item.likes.includes(userId);

    return {
      ...item,
      likes: liked
        ? item.likes.filter((u) => u !== userId)
        : [...item.likes, userId],
    };
  });

  await placeRef.update({ comments: updated });

  res.json({ success: true });
});

app.post("/comments/reply", async (req, res) => {
  const { placeId, parentId, userId, name, avatar, comment } = req.body;

  const placeRef = admin.firestore().collection("places").doc(placeId);
  const snap = await placeRef.get();
  const comments = snap.data().comments || [];

  const newReply = {
    id: Date.now().toString(),
    userId,
    name,
    avatar,
    comment,
    createdAt: Date.now(),
  };

  const updated = comments.map((item) =>
    item.id === parentId
      ? { ...item, replies: [...item.replies, newReply] }
      : item
  );

  await placeRef.update({ comments: updated });

  res.json({ success: true, reply: newReply });
});

app.get("/comments/:placeId", async (req, res) => {
  const placeId = req.params.placeId;

  const snap = await admin.firestore().collection("places").doc(placeId).get();

  if (!snap.exists) return res.json({ success: false });

  let comments = snap.data().comments || [];
  comments = comments.sort((a, b) => b.createdAt - a.createdAt);

  res.json({ success: true, comments });
});

// 🔥 YORUM RAPOR ETME
app.post("/comments/report", async (req, res) => {
  try {
    const {
      placeId,
      commentId,
      userId, // rapor eden
      reporterName,
      commentOwnerId, // rapor edilen
      reason,
      commentText,
      commentOwnerName,
    } = req.body;

    if (!placeId || !commentId || !userId || !commentOwnerId || !reason) {
      return res.json({ success: false, error: "Eksik bilgi gönderildi." });
    }

    const reportId = Date.now().toString(); // unique ID

    const reportData = {
      id: reportId, // 🔥 yeni: document ID
      placeId,
      commentId,
      reportedUserId: commentOwnerId,
      reportedUserName: commentOwnerName,
      reportedComment: commentText,
      reason,
      reporterId: userId,
      reporterName,
      createdAt: Date.now(),
    };

    // 🔥 reports -> {reportId}
    await admin.firestore().collection("reports").doc(reportId).set(reportData);

    return res.json({ success: true, reportId });
  } catch (err) {
    console.log("report error:", err);
    return res.json({ success: false, error: "Sunucu hatası" });
  }
});

// ------------------------------
// ADMIN — USERS GET ALL
// ------------------------------
app.get("/admin/users/getAll", checkAdmin, async (req, res) => {
  try {
    const snap = await db.collection("users").get();
    const users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    return res.json({ success: true, users });
  } catch (err) {
    console.log("get users error:", err);
    return res.status(500).json({ success: false });
  }
});

// ------------------------------
// ADMIN — USER DELETE
// ------------------------------
app.post("/admin/users/delete", checkAdmin, async (req, res) => {
  const { targetId } = req.body;

  if (!targetId)
    return res.json({ success: false, error: "targetId gerekli." });

  try {
    await db.collection("users").doc(targetId).delete();
    return res.json({ success: true });
  } catch (err) {
    console.log("delete user error:", err);
    return res.status(500).json({ success: false });
  }
});

// ------------------------------
// ADMIN — USER BAN
// ------------------------------
app.post("/admin/users/ban", checkAdmin, async (req, res) => {
  const { targetId, hours, banType } = req.body;

  if (!targetId || !hours)
    return res.json({ success: false, error: "Eksik bilgi." });

  const expiresAt = Date.now() + hours * 3600 * 1000;

  try {
    await db
      .collection("users")
      .doc(targetId)
      .update({
        banExpiresAt: expiresAt,
        banType: banType || "all",
      });

    return res.json({ success: true });
  } catch (err) {
    console.log("ban user error:", err);
    return res.status(500).json({ success: false });
  }
});

app.post("/admin/users/unban", checkAdmin, async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.json({ success: false, error: "userId gerekli." });
  }

  try {
    await db.collection("users").doc(userId).update({
      banExpiresAt: 0,
      banType: "none",
    });

    return res.json({ success: true });
  } catch (err) {
    console.log("UNBAN ERROR:", err);
    return res.status(500).json({ success: false, error: "UNBAN_FAILED" });
  }
});

app.get("/admin/reports/getAll", checkAdmin, async (req, res) => {
  try {
    const snap = await db.collection("reports").get();
    const reports = snap.docs.map((d) => ({ reportId: d.id, ...d.data() }));

    return res.json({ success: true, reports });
  } catch (err) {
    console.log("get reports error:", err);
    return res.status(500).json({ success: false });
  }
});

// ------------------------------
// ADMIN — REPORT DELETE
// ------------------------------
app.post("/admin/reports/delete", checkAdmin, async (req, res) => {
  const { reportId } = req.body;

  if (!reportId)
    return res.json({ success: false, error: "Rapor id gerekli." });

  try {
    await db.collection("reports").doc(reportId).delete();
    return res.json({ success: true });
  } catch (err) {
    console.log("delete report error:", err);
    return res.status(500).json({ success: false });
  }
});

// ------------------------------
// ADMIN — COMMENT DELETE
// ------------------------------
app.post("/admin/comments/delete", checkAdmin, async (req, res) => {
  const { placeId, commentId, reportId } = req.body;
  console.log(placeId, commentId, reportId);

  if (placeId && commentId && reportId) {
    try {
      const placeRef = db.collection("places").doc(placeId);
      const placeSnap = await placeRef.get();

      if (!placeSnap.exists)
        return res.json({ success: false, error: "Place bulunamadı." });

      const place = placeSnap.data();

      // 🔥 MongoDB değil → Firestore comment ID = item.id
      const newComments = (place.comments || []).filter(
        (c) => c.id !== commentId
      );

      await placeRef.update({ comments: newComments });
      if (reportId) {
        await db.collection("reports").doc(reportId).delete();
      }
      return res.json({ success: true });
    } catch (err) {
      console.log("delete comment error:", err);
      return res.status(500).json({ success: false });
    }
  } else if (!placeId && !commentId && reportId) {
    try {
      await db.collection("reports").doc(reportId).delete();
      return res.json({ success: true });
    } catch (err) {
      console.log("Clear report error:", err);
      return res.status(500).json({ success: false });
    }
  } else {
    return res.status(500).json({ success: false });
  }
});
// ------------------------------
// ADMIN — GET ALL PLACES
// ------------------------------
app.get("/admin/places/getAll", checkAdmin, async (req, res) => {
  try {
    const snap = await db.collection("places").get();
    const places = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    return res.json({ success: true, places });
  } catch (err) {
    console.log("get places error:", err);
    return res.status(500).json({ success: false });
  }
});

// ------------------------------
// ADMIN — DELETE PLACE
// ------------------------------
app.post("/admin/places/delete", checkAdmin, async (req, res) => {
  const { placeId } = req.body;

  if (!placeId) return res.json({ success: false, error: "placeId gerekli." });

  try {
    await db.collection("places").doc(placeId).delete();

    return res.json({ success: true });
  } catch (err) {
    console.log("delete place error:", err);
    return res.status(500).json({ success: false });
  }
});

// =========================
//  ADMIN - GET DASHBOARD STATS
// =========================
app.get("/admin/stats", async (req, res) => {
  try {
    const { uid } = req.query;

    if (!uid) {
      return res.status(400).json({ success: false, error: "Eksik parametre" });
    }

    const userRef = admin.firestore().collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists || userSnap.data().role !== "admin") {
      return res.status(403).json({
        success: false,
        error: "Admin yetkisi gereklidir.",
      });
    }

    // Firestore referansları
    const usersRef = admin.firestore().collection("users");
    const placesRef = admin.firestore().collection("places");
    const reportsRef = admin.firestore().collection("reports");

    // ---------- TOTAL COUNTS ----------
    const [usersSnap, placesSnap, reportsSnap] = await Promise.all([
      usersRef.get(),
      placesRef.get(),
      reportsRef.get(),
    ]);

    // COMMENT COUNT
    let totalComments = 0;
    placesSnap.forEach((p) => {
      const c = p.data().comments || [];
      totalComments += c.length;
    });

    // ---------- LAST 7 DAYS GROWTH ----------
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const userGrowth = [];
    const placeGrowth = [];

    for (let i = 6; i >= 0; i--) {
      const start = now - i * day;
      const end = start + day;

      // users
      const u = usersSnap.docs.filter((d) => {
        const t = d.data().createdAt || 0;
        return t >= start && t < end;
      }).length;

      // places
      const p = placesSnap.docs.filter((d) => {
        const t = d.data().createdAt || 0;
        return t >= start && t < end;
      }).length;

      userGrowth.push({ value: u });
      placeGrowth.push({ value: p });
    }

    // ---------- MOST ACTIVE USERS ----------
    const userActivity = {};

    placesSnap.forEach((p) => {
      const placeData = p.data();
      const uid = placeData.userId;
      const comments = placeData.comments || [];

      if (!userActivity[uid]) userActivity[uid] = 0;

      userActivity[uid] += 1; // place eklediği için
      userActivity[uid] += comments.length; // yaptığı yorumlar
    });

    const topUsers = Object.entries(userActivity)
      .map(([uid, count]) => {
        const userDoc = usersSnap.docs.find((u) => u.id === uid);
        return {
          id: uid,
          name: userDoc?.data()?.name || "Unknown",
          count,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // ---------- MOST COMMENTED PLACES ----------
    const mostCommented = placesSnap.docs
      .map((p) => {
        const d = p.data();
        return {
          id: p.id,
          name: d.name,
          count: (d.comments || []).length,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return res.json({
      success: true,
      stats: {
        totalUsers: usersSnap.size,
        totalPlaces: placesSnap.size,
        totalComments,
        totalReports: reportsSnap.size,
        userGrowth,
        placeGrowth,
        topUsers,
        mostCommented,
      },
    });
  } catch (err) {
    console.log("ADMIN STATS ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "Server error",
    });
  }
});

//VİSİT//

app.get("/visited/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const snap = await db.collection("visitedPlaces").doc(userId).get();

    if (!snap.exists) {
      return res.json({ success: true, visits: {} });
    }

    return res.json({ success: true, visits: snap.data() });
  } catch (err) {
    console.log("VISITED GET ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.post("/visits/detail", async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || ids.length === 0) {
      return res.json({ success: true, visits: [] });
    }

    const visits = await Promise.all(
      ids.map(async (id) => {
        const snap = await db.collection("visits").doc(id).get();
        if (!snap.exists) return null;

        const data = snap.data();

        // teammatesFull oluştur
        const teammatesFull = {};
        await Promise.all(
          data.teammates.map(async (uid) => {
            const u = await db.collection("users").doc(uid).get();
            teammatesFull[uid] = { id: uid, ...u.data() };
          })
        );

        return {
          id,
          ...data,
          teammatesFull: Object.values(teammatesFull),
          userMap: teammatesFull,
        };
      })
    );

    return res.json({ success: true, visits: visits.filter((v) => v) });
  } catch (err) {
    console.log("VISITS DETAIL ERROR:", err);
    return res
      .status(500)
      .json({ success: false, error: "Visits detail error" });
  }
});

// DELETE VISIT (herkesten siler)
app.post("/visits/delete", async (req, res) => {
  try {
    const { visitId } = req.body;

    if (!visitId) return res.json({ success: false, error: "visitId gerekli" });

    // 1) visits → komple sil
    await db.collection("visits").doc(visitId).delete();

    // 2) herkesin visitedPlaces listesinden kaldır
    const allUsers = await db.collection("visitedPlaces").get();

    for (let doc of allUsers.docs) {
      await doc.ref.update({
        [visitId]: admin.firestore.FieldValue.delete(),
      });
    }

    return res.json({ success: true });
  } catch (err) {
    console.log("VISIT DELETE ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.post("/visits/addOrUpdate", async (req, res) => {
  try {
    const {
      visitId,
      placeId,
      name,
      city,
      teammates,
      startDate,
      endDate,
      experience,
      photos,
    } = req.body;

    if (!placeId || !teammates || teammates.length === 0) {
      return res.json({ success: false, error: "Eksik bilgi gönderildi." });
    }

    // -----------------------------
    // 🔥 Eğer UPDATE ise
    // -----------------------------
    if (visitId) {
      await db
        .collection("visits")
        .doc(visitId)
        .update({
          placeId,
          placeName: name,
          city,
          teammates, // ID listesi
          startDate: new Date(startDate).getTime(),
          endDate: new Date(endDate).getTime(),
          experience,
          photos,
          updatedAt: Date.now(),
        });

      return res.json({ success: true, message: "updated" });
    }

    // -----------------------------
    // 🔥 NEW VISIT
    // -----------------------------
    const visitRef = await db.collection("visits").add({
      placeId,
      placeName: name,
      city,
      teammates, // uid listesi
      startDate: new Date(startDate).getTime(),
      endDate: new Date(endDate).getTime(),
      experience,
      photos,
      createdAt: Date.now(),
    });

    const visitIdNew = visitRef.id;

    // -----------------------------
    // 🔥 Gitti → her kişinin hesabına kaydet
    // visited -> userId -> { visitId : true }
    // -----------------------------
    await Promise.all(
      teammates.map(async (uid) => {
        await db
          .collection("visited")
          .doc(uid)
          .set({ [visitIdNew]: true }, { merge: true });
      })
    );

    return res.json({ success: true, id: visitIdNew });
  } catch (err) {
    console.log("VISIT ADD/UPDATE ERROR:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
app.listen(process.env.PORT || 5000, () => {
  console.log("🔥 Backend running on port", process.env.PORT || 5000);
});
