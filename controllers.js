// controllers.js
import admin, { db, auth } from "./firebase.js";
import jwt from "jsonwebtoken";

/* -----------------------------------
   JWT token üretici
----------------------------------- */
function createToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
}

/* -----------------------------------
   REGISTER
----------------------------------- */
export const register = async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    // email var mı?
    let exists = await admin
      .auth()
      .getUserByEmail(email)
      .catch(() => null);
    if (exists) return res.status(400).json({ error: "EMAIL_EXISTS" });

    // firebase auth user oluştur
    const user = await admin.auth().createUser({
      email,
      password,
      displayName: name,
    });

    // firestore kayıt
    await db.collection("users").doc(user.uid).set({
      name,
      email,
      phone,
      password,
      createdAt: Date.now(),
    });

    return res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "REGISTER_FAILED" });
  }
};

/* -----------------------------------
   LOGIN
----------------------------------- */
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const snap = await db
      .collection("users")
      .where("email", "==", email)
      .limit(1)
      .get();

    if (snap.empty)
      return res.status(400).json({ error: "INVALID_CREDENTIALS" });

    const user = snap.docs[0].data();
    const uid = snap.docs[0].id;

    if (user.password !== password)
      return res.status(400).json({ error: "INVALID_CREDENTIALS" });

    const token = createToken({ uid });

    return res.json({ success: true, token, uid });
  } catch {
    res.status(500).json({ error: "LOGIN_FAILED" });
  }
};

/* -----------------------------------
   GOOGLE LOGIN
----------------------------------- */
export const googleLogin = async (req, res) => {
  try {
    const { idToken } = req.body;

    const decoded = await auth.verifyIdToken(idToken);
    const uid = decoded.uid;
    const email = decoded.email;

    await db.collection("users").doc(uid).set(
      {
        email,
        google: true,
      },
      { merge: true }
    );

    const token = createToken({ uid });

    res.json({ success: true, token, uid });
  } catch {
    res.status(401).json({ error: "GOOGLE_LOGIN_FAILED" });
  }
};

/* -----------------------------------
   ME
----------------------------------- */
export const me = async (req, res) => {
  try {
    const doc = await db.collection("users").doc(req.user.uid).get();
    if (!doc.exists) return res.status(404).json({ error: "NOT_FOUND" });

    res.json({ uid: req.user.uid, ...doc.data() });
  } catch {
    res.status(500).json({ error: "ME_FAILED" });
  }
};

/* -----------------------------------
   OTP GÖNDER (ŞİFRE RESET)
----------------------------------- */
export const sendResetOTP = async (req, res) => {
  try {
    const { phone } = req.body;

    const snap = await db
      .collection("users")
      .where("phone", "==", phone)
      .limit(1)
      .get();
    if (snap.empty) return res.status(400).json({ error: "NO_USER" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    await db
      .collection("password_resets")
      .doc(phone)
      .set({
        otp,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

    // Prod'da OTP return edilmez ama test için bırakıyorum
    res.json({ success: true, otp });
  } catch {
    res.status(500).json({ error: "OTP_SEND_FAILED" });
  }
};

/* -----------------------------------
   OTP DOĞRULAMA
----------------------------------- */
export const verifyResetOTP = async (req, res) => {
  try {
    const { phone, otp } = req.body;

    const doc = await db.collection("password_resets").doc(phone).get();

    if (!doc.exists) return res.status(400).json({ error: "NO_OTP" });

    const data = doc.data();

    if (data.otp !== otp) return res.status(400).json({ error: "INVALID_OTP" });

    if (Date.now() > data.expiresAt)
      return res.status(400).json({ error: "OTP_EXPIRED" });

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "OTP_VERIFY_FAILED" });
  }
};

/* -----------------------------------
   ŞİFRE YENİLEME
----------------------------------- */
export const resetPassword = async (req, res) => {
  try {
    const { phone, newPassword } = req.body;

    const snap = await db
      .collection("users")
      .where("phone", "==", phone)
      .limit(1)
      .get();
    if (snap.empty) return res.status(400).json({ error: "NO_USER" });

    const userDoc = snap.docs[0];
    const uid = userDoc.id;

    await admin.auth().updateUser(uid, { password: newPassword });
    await userDoc.ref.update({ password: newPassword });

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "RESET_FAILED" });
  }
};

/* -----------------------------------
   PLACE EKLE
----------------------------------- */
export const addPlace = async (req, res) => {
  try {
    const { name, city, description, images } = req.body;

    const docRef = db.collection("places").doc();
    await docRef.set({
      name,
      city,
      description,
      images: images || [],
      createdAt: Date.now(),
    });

    res.json({ success: true, id: docRef.id });
  } catch {
    res.status(500).json({ error: "ADD_PLACE_FAILED" });
  }
};

/* -----------------------------------
   PLACE LIST
----------------------------------- */
export const listPlaces = async (req, res) => {
  try {
    const snap = await db.collection("places").get();
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json(list);
  } catch {
    res.status(500).json({ error: "LIST_PLACES_FAILED" });
  }
};

/* -----------------------------------
   FAVORITE
----------------------------------- */
export const addFavorite = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { placeId } = req.body;

    await db.collection("favorites").doc(`${uid}_${placeId}`).set({
      uid,
      placeId,
      createdAt: Date.now(),
    });

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "ADD_FAVORITE_FAILED" });
  }
};

export const removeFavorite = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { placeId } = req.body;

    await db.collection("favorites").doc(`${uid}_${placeId}`).delete();

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "REMOVE_FAVORITE_FAILED" });
  }
};

/* -----------------------------------
   COMMENT
----------------------------------- */
export const addComment = async (req, res) => {
  try {
    const { placeId, text } = req.body;

    const id = db.collection("comments").doc().id;

    await db.collection("comments").doc(id).set({
      placeId,
      text,
      uid: req.user.uid,
      createdAt: Date.now(),
    });

    res.json({ success: true, id });
  } catch {
    res.status(500).json({ error: "ADD_COMMENT_FAILED" });
  }
};

export const listComments = async (req, res) => {
  try {
    const { placeId } = req.query;

    const snap = await db
      .collection("comments")
      .where("placeId", "==", placeId)
      .get();

    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    res.json(list);
  } catch {
    res.status(500).json({ error: "LIST_COMMENTS_FAILED" });
  }
};

export async function getIncomingRequests(req, res) {
  const uid = req.user.uid;

  const snap = await db
    .collection("teamRequests")
    .where("to", "==", uid)
    .where("status", "==", "pending")
    .get();

  const list = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    const user = await db.collection("users").doc(data.from).get();

    list.push({
      id: doc.id,
      from: data.from,
      user: user.data(),
    });
  }

  return res.json({ requests: list });
}

export async function acceptTeammate(req, res) {
  const { requestId } = req.body;
  const uid = req.user.uid;

  const snap = await db.collection("teamRequests").doc(requestId).get();
  if (!snap.exists) return res.status(404).json({ error: "Request not found" });

  const { from } = snap.data();

  // 1) İlişkileri kaydet
  await db
    .collection("users")
    .doc(uid)
    .collection("teammates")
    .doc(from)
    .set({ uid: from });
  await db
    .collection("users")
    .doc(from)
    .collection("teammates")
    .doc(uid)
    .set({ uid });

  // 2) isteği güncelle
  await snap.ref.update({ status: "accepted" });

  return res.json({ success: true });
}

export async function rejectTeammate(req, res) {
  const { requestId } = req.body;

  await db
    .collection("teamRequests")
    .doc(requestId)
    .update({ status: "rejected" });

  return res.json({ success: true });
}
