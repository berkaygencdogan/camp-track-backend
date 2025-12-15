const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const { v4: uuidv4 } = require("uuid");
const { getStorage } = require("firebase-admin/storage");
const multer = require("multer");

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

  if (!authHeader) {
    return res.status(401).json({ error: "NO_TOKEN" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    console.log("JWT ERROR:", err);
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

const generateKeywords = (name) => {
  const low = name.toLowerCase();
  const keys = [];
  for (let i = 1; i <= low.length; i++) {
    keys.push(low.substring(0, i));
  }
  return keys;
};

app.post("/uploadImage", async (req, res) => {
  try {
    const { imageBase64, userId } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ success: false, message: "No image" });
    }

    const buffer = Buffer.from(imageBase64, "base64");
    const fileName = `uploads/${userId}_${Date.now()}.jpg`;

    const bucket = admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET);
    const file = bucket.file(fileName);

    await file.save(buffer, {
      metadata: { contentType: "image/jpeg" },
    });

    const url = await file.getSignedUrl({
      action: "read",
      expires: "03-01-2099",
    });

    res.json({ success: true, url: url[0] });
  } catch (err) {
    console.log("UPLOAD IMAGE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

app.post("/uploadMedia", async (req, res) => {
  try {
    const { base64, userId, isVideo } = req.body;

    if (!base64) {
      return res.status(400).json({ error: "Missing base64" });
    }

    const buffer = Buffer.from(base64, "base64");
    const bucket = admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET);
    const fileName = `${userId}_${Date.now()}.${isVideo ? "mp4" : "jpg"}`;
    const file = bucket.file(`uploads/${fileName}`);

    await file.save(buffer, {
      metadata: {
        contentType: isVideo ? "video/mp4" : "image/jpeg",
      },
    });

    const url = await file.getSignedUrl({
      action: "read",
      expires: "12-31-2099",
    });

    res.json({ url: url[0] });
  } catch (err) {
    console.log("MEDIA UPLOAD ERROR:", err);
    res.status(500).json({ error: "Upload error" });
  }
});

// Belleğe yükleyen storage

const upload = multer({ storage: multer.memoryStorage() });

app.post("/uploadMediaStream", upload.single("file"), async (req, res) => {
  try {
    const { userId, isVideo } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "No file received" });
    }

    const bucket = admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET);

    const fileName = `${userId}_${Date.now()}.${
      isVideo === "true" ? "mp4" : "jpg"
    }`;
    const file = bucket.file(`uploads/${fileName}`);

    await file.save(req.file.buffer, {
      metadata: {
        contentType: isVideo === "true" ? "video/mp4" : "image/jpeg",
      },
    });

    const url = await file.getSignedUrl({
      action: "read",
      expires: "12-31-2099",
    });

    res.json({ success: true, url: url[0] });
  } catch (err) {
    console.log("MEDIA STREAM UPLOAD ERROR:", err);
    res.status(500).json({ error: "Upload error" });
  }
});

app.get("/user/:userId/gallery", async (req, res) => {
  try {
    const userId = req.params.userId;
    const doc = await db.collection("posts").doc(userId).get();

    if (!doc.exists) {
      return res.json({ posts: [] });
    }

    const data = doc.data();
    const posts = data.posts || [];

    // 🔥 Post sahibini 1 kez çek
    const ownerSnap = await db.collection("users").doc(userId).get();
    const owner = ownerSnap.exists ? ownerSnap.data() : {};

    for (const post of posts) {
      // 🔥 Post sahibinin avatar ve ismini ekle
      post.userAvatar =
        owner.avatar ||
        `https://ui-avatars.com/api/?name=${owner.nickname || owner.name}`;
      post.username = owner.nickname || owner.name || "Unknown";

      // 🔥 Yorumları zenginleştir (avatar + username)
      if (post.comments && post.comments.length > 0) {
        const newComments = [];

        for (const c of post.comments) {
          const cUserSnap = await db.collection("users").doc(c.userId).get();
          const cUser = cUserSnap.exists ? cUserSnap.data() : {};

          newComments.push({
            ...c,
            username: cUser.nickname || cUser.name || "Unknown",
            userAvatar:
              cUser.avatar ||
              `https://ui-avatars.com/api/?name=${
                cUser.nickname || cUser.name
              }`,
          });
        }

        post.comments = newComments;
      }
    }

    // 🆕 En yeni post en üstte
    posts.sort((a, b) => b.createdAt - a.createdAt);

    res.json({ posts });
  } catch (err) {
    console.log("GALLERY FETCH ERROR:", err);
    res.status(500).json({ error: "Gallery fetch error" });
  }
});

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

app.post("/teams/delete", async (req, res) => {
  try {
    const { teamId, userId } = req.body;

    if (!teamId) return res.status(400).json({ error: "TEAM_ID_REQUIRED" });

    // TEAM GET
    const snap = await db.collection("teams").doc(teamId).get();
    if (!snap.exists) return res.status(404).json({ error: "TEAM_NOT_FOUND" });

    const team = snap.data();
    const members = team.members || [];
    const ownerId = members[0];
    const currentUserId = userId;

    if (currentUserId !== ownerId) {
      const updatedMembers = members.filter((m) => m !== currentUserId);

      await db.collection("teams").doc(teamId).update({
        members: updatedMembers,
      });

      return res.json({
        success: true,
        action: "LEAVE_TEAM",
        members: updatedMembers,
      });
    }

    if (team.logo) {
      try {
        const bucket = admin
          .storage()
          .bucket(process.env.FIREBASE_STORAGE_BUCKET);
        const path = team.logo.split(
          process.env.FIREBASE_STORAGE_BUCKET + "/"
        )[1];
        if (path) {
          await bucket.file(path).delete();
        }
      } catch (err) {
        console.log("LOGO DELETE ERROR:", err);
      }
    }

    await db.collection("teams").doc(teamId).delete();

    return res.json({
      success: true,
      action: "DELETE_TEAM",
    });
  } catch (err) {
    console.log("DELETE_TEAM_ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.post("/teams/update", async (req, res) => {
  try {
    const { teamId, newName, newLogoBase64 } = req.body;

    const snap = await db.collection("teams").doc(teamId).get();
    if (!snap.exists) {
      return res.status(404).json({ error: "TEAM_NOT_FOUND" });
    }

    const team = snap.data();

    // OWNER CHECK — takımın kurucusu her zaman members[0]
    const ownerId = team.members[0];
    if (!ownerId) {
      return res.status(400).json({ error: "INVALID_TEAM_OWNER" });
    }

    // frontend ownerId göndermiyor, backend kontrol ediyor
    if (req.user?.uid && req.user.uid !== ownerId) {
      // Eğer JWT kullanıyorsan böyle kontrol edilir
      return res.status(403).json({ error: "NO_PERMISSION" });
    }

    const updateData = {};

    // yeni ad
    if (newName) updateData.teamName = newName;

    // yeni logo
    if (newLogoBase64) {
      const buffer = Buffer.from(newLogoBase64, "base64");
      const fileName = `teamLogos/${teamId}.jpg`;

      const bucket = admin
        .storage()
        .bucket(process.env.FIREBASE_STORAGE_BUCKET);
      const file = bucket.file(fileName);

      await file.save(buffer, {
        metadata: { contentType: "image/jpeg" },
        public: true,
      });

      await file.makePublic();

      const url = `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/${fileName}`;
      updateData.logo = url;
    }

    await db.collection("teams").doc(teamId).update(updateData);

    res.json({ success: true, update: updateData });
  } catch (err) {
    console.log("TEAM_UPDATE_ERROR:", err);
    res.status(500).json({ success: false });
  }
});

app.post("/teams/remove-member", async (req, res) => {
  try {
    const { teamId, userId } = req.body;

    const snap = await db.collection("teams").doc(teamId).get();
    if (!snap.exists) {
      return res.status(404).json({ error: "TEAM_NOT_FOUND" });
    }

    const team = snap.data();

    // OWNER CHECK
    const ownerId = team.members[0];
    if (!ownerId) {
      return res.status(400).json({ error: "INVALID_TEAM_OWNER" });
    }

    if (req.user?.uid && req.user.uid !== ownerId) {
      return res.status(403).json({ error: "NO_PERMISSION" });
    }

    // üye silme
    const updated = team.members.filter((id) => id !== userId);

    await db.collection("teams").doc(teamId).update({
      members: updated,
    });

    res.json({ success: true, members: updated });
  } catch (err) {
    console.log("REMOVE_MEMBER_ERROR:", err);
    res.status(500).json({ success: false });
  }
});

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

app.post("/user/update", async (req, res) => {
  try {
    const { userId, avatar, coverPhoto, nickname, bio } = req.body;

    if (!userId) {
      return res.json({ success: false, msg: "userId missing" });
    }

    const userRef = db.collection("users").doc(userId);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.json({ success: false, msg: "User not found" });
    }

    // Güncellenecek alanlar
    const updateData = {};

    if (avatar !== undefined) updateData.avatar = avatar;
    if (coverPhoto !== undefined) updateData.coverPhoto = coverPhoto;
    if (nickname !== undefined) updateData.nickname = nickname;
    if (bio !== undefined) updateData.bio = bio;

    // Firestore güncelleme
    await userRef.update(updateData);

    // Güncellenmiş kullanıcı verisi
    const updatedUser = (await userRef.get()).data();

    return res.json({
      success: true,
      user: updatedUser,
    });
  } catch (err) {
    console.log("USER UPDATE ERROR:", err);
    return res.json({
      success: false,
      msg: "UPDATE_FAILED",
    });
  }
});

app.get("/places/search", async (req, res) => {
  try {
    let q = (req.query.query || "").trim().toLowerCase();
    if (!q) return res.json({ places: [] });

    // Kullanıcı 1 kelime değil 2-3 kelime yazabilir → hepsini al
    const terms = q.split(" ").filter(Boolean);

    const snap = await db.collection("places").get();
    const allPlaces = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const results = allPlaces.filter((p) => {
      const name = p.name?.toLowerCase() || "";
      const city = p.city?.toLowerCase() || "";

      // Kullanıcının yazdığı her kelime eşleşmek zorunda
      return terms.every((word) => {
        return name.includes(word) || city.includes(word);
      });
    });

    res.json({ places: results });
  } catch (err) {
    console.log("PLACE SEARCH ERROR:", err);
    res.status(500).json({ places: [] });
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

const uploadBase64Image = async (base64, path) => {
  const buffer = Buffer.from(base64, "base64");
  const bucket = admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET);
  const file = bucket.file(path);

  await file.save(buffer, {
    metadata: { contentType: "image/jpeg" },
  });

  await file.makePublic();

  return `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/${path}`;
};

app.post("/places/add", async (req, res) => {
  try {
    const {
      userId,
      name,
      country,
      city,
      district,
      description,
      properties = [],
      photos,
      location,
    } = req.body;

    if (
      !userId ||
      !name ||
      !country ||
      !city ||
      !district ||
      !photos?.length ||
      !location
    ) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    // -------------------------
    // FOTOĞRAFLARI YÜKLE
    // -------------------------
    const uploadedPhotos = [];

    for (let i = 0; i < photos.length; i++) {
      const base64 = photos[i].replace(/^data:image\/\w+;base64,/, "");

      const url = await uploadBase64Image(
        base64,
        `places/${userId}_${Date.now()}_${i}.jpg`
      );

      uploadedPhotos.push(url);
    }

    // -------------------------
    // FIRESTORE'A KAYDET
    // -------------------------
    const ref = await db.collection("places").add({
      name,
      country,
      city,
      district,
      description: description || "",
      properties, // 🔥 yeni
      photos: uploadedPhotos,
      addedBy: userId,
      createdAt: Date.now(),
      latitude: location.latitude,
      longitude: location.longitude,
      geopoint: new admin.firestore.GeoPoint(
        location.latitude,
        location.longitude
      ),
      isPopular: false,
    });

    return res.json({ success: true, id: ref.id });
  } catch (err) {
    console.log("ADD_PLACE_ERROR:", err);
    res.status(500).json({ error: "PLACE_ADD_FAILED" });
  }
});

app.get("/places/all", async (req, res) => {
  try {
    const snap = await db.collection("places").get();

    const places = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        name: d.name,
        country: d.country,
        city: d.city,
        district: d.district,
        latitude: d.latitude,
        longitude: d.longitude,
        properties: d.properties || [],
        photo: d.photos?.[0] || null, // sadece ilk foto
      };
    });

    return res.json({ success: true, places });
  } catch (err) {
    console.log("PLACES_ALL_ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.get("/google/autocomplete", async (req, res) => {
  try {
    const input = req.query.input;
    if (!input) return res.json({ predictions: [] });

    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(
      input
    )}&key=${process.env.GOOGLE_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    res.json(data);
  } catch (err) {
    console.log("GOOGLE_AUTOCOMPLETE_ERROR:", err);
    res.json({ predictions: [] });
  }
});

app.get("/google/details", async (req, res) => {
  try {
    const placeId = req.query.place_id;

    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&key=${process.env.GOOGLE_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    res.json(data);
  } catch (err) {
    console.log("GOOGLE_DETAILS_ERROR:", err);
    res.json({});
  }
});

app.get("/places/nearby", async (req, res) => {
  try {
    const { lat, lng, radius = 25 } = req.query;

    if (!lat || !lng) {
      return res
        .status(400)
        .json({ success: false, error: "Missing location" });
    }

    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    const rad = parseFloat(radius);

    // Yaklaşık derece hesapları
    const latDeg = rad / 110.574;
    const lngDeg = rad / (111.32 * Math.cos((userLat * Math.PI) / 180));

    const minLat = userLat - latDeg;
    const maxLat = userLat + latDeg;
    const minLng = userLng - lngDeg;
    const maxLng = userLng + lngDeg;

    const snap = await db.collection("places").get();
    const places = [];

    snap.forEach((doc) => {
      const d = doc.data();

      if (
        d.latitude >= minLat &&
        d.latitude <= maxLat &&
        d.longitude >= minLng &&
        d.longitude <= maxLng
      ) {
        places.push({
          id: doc.id,
          name: d.name,
          city: d.city,
          lat: d.latitude,
          lng: d.longitude,
          photo: d.photos?.[0] || null,
        });
      }
    });

    return res.json({ success: true, places });
  } catch (err) {
    console.log("NEARBY_ERROR:", err);
    return res.status(500).json({ success: false });
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

    // 🔥 JWT artık id içeriyor!
    const token = jwt.sign(
      { id: data.localId, email },
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

app.post("/post/comment", async (req, res) => {
  try {
    const { userId, ownerId, index, text } = req.body;

    if (!userId || !ownerId || index === undefined || !text) {
      return res.status(400).json({ success: false, msg: "MISSING_FIELDS" });
    }

    const userPostsRef = db.collection("posts").doc(ownerId);
    const snap = await userPostsRef.get();

    if (!snap.exists)
      return res
        .status(404)
        .json({ success: false, msg: "User posts not found" });

    const postsArray = snap.data().posts || [];

    if (index < 0 || index >= postsArray.length) {
      return res.status(400).json({ success: false, msg: "Invalid index" });
    }

    // Yorum atan kullanıcı
    const userSnap = await db.collection("users").doc(userId).get();
    const user = userSnap.data();

    const commentId = Date.now().toString();
    const newComment = {
      id: commentId,
      userId,
      username: user.name || user.nickname || "Unknown",
      userAvatar: user.avatar || "",
      text,
      createdAt: Date.now(),
    };

    // Yorumu ekle
    postsArray[index].comments = postsArray[index].comments || [];
    postsArray[index].comments.push(newComment);

    await userPostsRef.update({ posts: postsArray });

    // Bildirim
    if (userId !== ownerId) {
      const notifRef = db.collection("notifications").doc();

      await notifRef.set({
        id: notifRef.id,
        type: "comment",
        fromUserId: userId,
        toUserId: ownerId,
        createdAt: Date.now(),
        read: false,
        text: `${user.nickname} gönderine yorum yaptı: "${text}"`,
        postOwnerId: ownerId,
        postIndex: index,
        commentId, // 🔥 BURADA
      });
    }

    return res.json({ success: true, comment: newComment });
  } catch (err) {
    console.log("COMMENT ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.get("/auth/me", authMiddleware, async (req, res) => {
  try {
    const userSnap = await db.collection("users").doc(req.user.id).get();

    if (!userSnap.exists) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    return res.json({
      success: true,
      user: userSnap.data(),
    });
  } catch (err) {
    console.log("AUTH_ME_ERROR:", err);
    return res.status(500).json({ error: "AUTH_FAILED" });
  }
});

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

app.post("/notifications/send", async (req, res) => {
  try {
    const { fromUserId, toUserId, teamId, teamName } = req.body;
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

      const sender = await db.collection("users").doc(data.fromUserId).get();
      const senderInfo = sender.exists ? sender.data() : {};

      notifications.push({
        ...data,
        id: doc.id,
        fromName: senderInfo.nickname || senderInfo.name || "Unknown",
        fromAvatar: senderInfo.avatar || "",
      });
    }

    return res.json({ success: true, notifications });
  } catch (err) {
    console.log("NOTIFICATION LIST ERROR:", err);
    return res.json({ success: false });
  }
});

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

app.post("/notifications/delete", async (req, res) => {
  try {
    const { notifId } = req.body;

    if (!notifId || typeof notifId !== "string" || notifId.trim() === "") {
      return res.status(400).json({ success: false, msg: "INVALID_ID" });
    }

    await db.collection("notifications").doc(notifId).delete();

    return res.json({ success: true });
  } catch (err) {
    console.log("DELETE ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.get("/backpack/:userId", async (req, res) => {
  const { userId } = req.params;
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

app.get("/comments/:placeId", async (req, res) => {
  const placeId = req.params.placeId;

  const snap = await admin.firestore().collection("places").doc(placeId).get();

  if (!snap.exists) return res.json({ success: false });

  let comments = snap.data().comments || [];
  comments = comments.sort((a, b) => b.createdAt - a.createdAt);

  res.json({ success: true, comments });
});

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

app.post("/admin/comments/delete", checkAdmin, async (req, res) => {
  const { placeId, commentId, reportId } = req.body;

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

        // 🔥 place bilgisi alıyoruz
        const placeSnap = await db.collection("places").doc(data.placeId).get();
        const placeData = placeSnap.exists ? placeSnap.data() : null;

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

          // 🔥 Yeni eklenen alan:
          placePhotos: placeData?.photos || [],
          placeName: placeData?.name || data.placeName,
          city: placeData?.city || data.city,
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

app.post("/post/new", async (req, res) => {
  try {
    const { userId, caption, medias } = req.body; // 🔥 multiple medias

    if (!userId || !medias || medias.length === 0) {
      return res.status(400).json({ error: "Missing media" });
    }

    const userRef = db.collection("posts").doc(userId);
    const userDoc = await userRef.get();
    const userData = (await db.collection("users").doc(userId).get()).data();

    const newPost = {
      id: Date.now().toString(),
      userId,
      username: userData.name || "",
      userAvatar: userData.image || null,
      caption: caption || "",
      medias, // 🔥 array of media
      createdAt: Date.now(),
    };

    if (!userDoc.exists) {
      await userRef.set({ posts: [newPost] });
    } else {
      await userRef.update({
        posts: admin.firestore.FieldValue.arrayUnion(newPost),
      });
    }

    return res.json({ success: true });
  } catch (err) {
    console.log("POST NEW ERROR:", err);
    return res.status(500).json({ error: "Post create error" });
  }
});

app.get("/post/:postId", async (req, res) => {
  try {
    const doc = await db.collection("posts").doc(req.params.postId).get();
    if (!doc.exists) return res.json({ success: false, message: "Bulunamadı" });

    return res.json({ success: true, post: { id: doc.id, ...doc.data() } });
  } catch (err) {
    console.log("POST DETAIL ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.delete("/post/:postId/delete", async (req, res) => {
  try {
    await db.collection("posts").doc(req.params.postId).delete();
    return res.json({ success: true });
  } catch (err) {
    console.log("POST DELETE ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.put("/post/:postId/edit", async (req, res) => {
  try {
    const { caption, medias } = req.body; // 🔥 caption + medias
    const postId = req.params.postId;

    if (!caption && !medias) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    // Kullanıcı ID’sini bilmiyoruz → frontend query içinde owner gönderiyor
    const owner = req.query.owner;
    if (!owner) {
      return res.status(400).json({ error: "Owner missing" });
    }

    const postsRef = db.collection("posts").doc(owner);
    const doc = await postsRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "User posts not found" });
    }

    const data = doc.data();
    const posts = data.posts || [];

    // Hedef postu bul
    const index = posts.findIndex((p) => p.id == postId);
    if (index === -1) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Güncelle
    if (caption !== undefined) posts[index].caption = caption;
    if (medias !== undefined) posts[index].medias = medias; // 🔥 medya güncelleme

    posts[index].updatedAt = Date.now();

    // Firestore'a kaydet
    await postsRef.update({ posts });

    return res.json({ success: true });
  } catch (err) {
    console.log("POST EDIT ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.delete("/post/:postId/media", async (req, res) => {
  try {
    const { postId } = req.params;
    const { owner, url } = req.body;

    if (!owner || !url) {
      return res.status(400).json({ error: "Missing owner or url" });
    }

    const postsRef = db.collection("posts").doc(owner);
    const doc = await postsRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "User posts not found" });
    }

    const posts = doc.data().posts || [];

    const index = posts.findIndex((p) => p.id == postId);
    if (index === -1) {
      return res.status(404).json({ error: "Post not found" });
    }

    // ❌ istenen medyayı array'den sil
    posts[index].medias = posts[index].medias.filter((m) => m.url !== url);
    posts[index].updatedAt = Date.now();

    await postsRef.update({ posts });

    return res.json({ success: true, medias: posts[index].medias });
  } catch (err) {
    console.log("DELETE MEDIA ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.post("/post/:postId/comment", async (req, res) => {
  try {
    const { userId, text } = req.body;

    if (!userId || !text) return res.status(400).json({ success: false });

    const ref = await db
      .collection("posts")
      .doc(req.params.postId)
      .collection("comments")
      .add({
        userId,
        text,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    return res.json({ success: true, commentId: ref.id });
  } catch (err) {
    console.log("COMMENT ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.get("/post/:postId/comments", async (req, res) => {
  try {
    const snapshot = await db
      .collection("posts")
      .doc(req.params.postId)
      .collection("comments")
      .orderBy("createdAt", "asc")
      .get();

    const comments = snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }));

    return res.json({ success: true, comments });
  } catch (err) {
    console.log("COMMENT LIST ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.delete("/post/:postId/comment/:commentId/delete", async (req, res) => {
  try {
    await db
      .collection("posts")
      .doc(req.params.postId)
      .collection("comments")
      .doc(req.params.commentId)
      .delete();

    return res.json({ success: true });
  } catch (err) {
    console.log("COMMENT DELETE ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.post("/post/:postId/like", async (req, res) => {
  try {
    const { userId } = req.body;
    const ref = db.collection("posts").doc(req.params.postId);
    const doc = await ref.get();

    if (!doc.exists) return res.json({ success: false });

    const data = doc.data();
    let likedBy = data.likedBy || [];

    if (likedBy.includes(userId)) {
      likedBy = likedBy.filter((id) => id !== userId);
    } else {
      likedBy.push(userId);
    }

    await ref.update({ likedBy, likes: likedBy.length });

    return res.json({ success: true, likedBy, likes: likedBy.length });
  } catch (err) {
    console.log("LIKE ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.get("/user/:id", async (req, res) => {
  try {
    const userRef = db.collection("users").doc(req.params.id);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    const user = userSnap.data();

    // GALLERY
    const gallerySnap = await db
      .collection("posts")
      .where("userId", "==", req.params.id)
      .get();

    const posts = gallerySnap.docs.map((d) => d.data());

    // ADDED PLACES
    const addedSnap = await db
      .collection("places")
      .where("userId", "==", req.params.id)
      .get();

    const addedPlaces = addedSnap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }));

    // FAVORITES
    const favSnap = await db.collection("favorites").doc(req.params.id).get();

    const favorites = favSnap.exists ? favSnap.data().items || [] : [];

    // VISITED
    const visitSnap = await db.collection("visited").doc(req.params.id).get();

    const visited = visitSnap.exists ? visitSnap.data().items || [] : [];

    return res.json({
      success: true,
      user: user, // 🔥 TAM KULLANICI DATASI
      posts,
      addedPlaces,
      favorites,
      visited,
    });
  } catch (err) {
    console.log("USER FETCH ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

app.listen(process.env.PORT || 5000, () => {
  console.log("🔥 Backend running on port", process.env.PORT || 5000);
});
