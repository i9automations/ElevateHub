const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  now,
  id,
  hashPassword,
  verifyPassword,
  publicUser,
  profileDto,
  normalizeEmail,
  normalizeSquad,
  normalizeTags,
  applyProfileFields,
  profileFromImportRow,
  startUrlForSquad
} = require("./shared");

const TOKEN_TTL_MS = 1000 * 60 * 60 * 12;

class JsonStore {
  constructor(options = {}) {
    this.mode = "json";
    this.dbFile = options.dbFile;
    this.sessions = new Map();
  }

  defaultDb() {
    const adminEmail = process.env.V2_ADMIN_EMAIL || "admin@elevate.local";
    const adminPassword = process.env.V2_ADMIN_PASSWORD || "admin123";
    return {
      users: [{
        id: "usr_admin",
        name: "Admin",
        email: adminEmail,
        role: "admin",
        passwordHash: hashPassword(adminPassword),
        createdAt: now()
      }],
      profiles: [{
        id: "prf_demo",
        name: "Petala Beauty",
        tiktokEmail: "petalabeauty@elevateecom.com.br",
        mailboxEmail: "",
        squad: "fox",
        startUrl: startUrlForSquad("fox"),
        notes: "",
        tags: ["Demo", "Beauty"],
        sessionState: "ready",
        lockedBy: null,
        lockedAt: null,
        lastOpenedAt: null,
        createdAt: now()
      }],
      audit: []
    };
  }

  loadDb() {
    fs.mkdirSync(path.dirname(this.dbFile), { recursive: true });
    if (!fs.existsSync(this.dbFile)) {
      const db = this.defaultDb();
      this.saveDb(db);
      return db;
    }
    return JSON.parse(fs.readFileSync(this.dbFile, "utf8"));
  }

  saveDb(db) {
    fs.mkdirSync(path.dirname(this.dbFile), { recursive: true });
    fs.writeFileSync(this.dbFile, JSON.stringify(db, null, 2), "utf8");
  }

  async health() {
    return { store: this.mode };
  }

  issueToken(user) {
    const token = crypto.randomBytes(24).toString("hex");
    this.sessions.set(token, {
      userId: user.id,
      expiresAt: Date.now() + TOKEN_TTL_MS
    });
    return token;
  }

  async login(email, password) {
    const db = this.loadDb();
    const normalized = normalizeEmail(email);
    const user = db.users.find((item) => item.email.toLowerCase() === normalized);
    if (!user || !verifyPassword(String(password || ""), user.passwordHash)) {
      return null;
    }
    const token = this.issueToken(user);
    await this.audit(user, "auth.login", user.id);
    return { token, user: publicUser(user) };
  }

  async currentUser(token) {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) return null;
    const db = this.loadDb();
    const user = db.users.find((item) => item.id === session.userId);
    return user ? publicUser(user) : null;
  }

  async listUsers() {
    const db = this.loadDb();
    return db.users.map(publicUser);
  }

  async createUser(actor, body) {
    const db = this.loadDb();
    const name = String(body.name || "").trim();
    const email = normalizeEmail(body.email);
    if (!name || !email) throw new Error("Nome e e-mail sao obrigatorios");
    if (db.users.some((item) => item.email.toLowerCase() === email)) {
      const error = new Error("Usuario ja cadastrado");
      error.status = 409;
      throw error;
    }
    const temporaryPassword = String(body.password || "").trim() || crypto.randomBytes(6).toString("base64url");
    const created = {
      id: id("usr"),
      name,
      email,
      role: body.role === "admin" ? "admin" : "operator",
      passwordHash: hashPassword(temporaryPassword),
      createdAt: now()
    };
    db.users.push(created);
    this.saveDb(db);
    await this.audit(actor, "user.create", created.id, { email: created.email, role: created.role });
    return { user: publicUser(created), temporaryPassword };
  }

  async listProfiles() {
    const db = this.loadDb();
    return db.profiles.map((profile) => profileDto(db.users, profile));
  }

  async getProfile(profileId) {
    const db = this.loadDb();
    const profile = db.profiles.find((item) => item.id === profileId);
    return profile ? profileDto(db.users, profile) : null;
  }

  async saveProfile(profile) {
    const db = this.loadDb();
    const index = db.profiles.findIndex((item) => item.id === profile.id);
    if (index === -1) return null;
    db.profiles[index] = { ...db.profiles[index], ...profile };
    this.saveDb(db);
    return profileDto(db.users, db.profiles[index]);
  }

  async createProfile(actor, body) {
    const db = this.loadDb();
    const name = String(body.name || "").trim();
    if (!name) throw new Error("Nome vazio");
    const profile = {
      id: id("prf"),
      name,
      tiktokEmail: normalizeEmail(body.tiktokEmail),
      mailboxEmail: normalizeEmail(body.mailboxEmail),
      squad: normalizeSquad(body.squad),
      startUrl: startUrlForSquad(body.squad),
      notes: String(body.notes || "").trim(),
      responsavel: String(body.responsavel || "").trim(),
      tags: normalizeTags(body.tags),
      sessionState: "empty",
      lockedBy: null,
      lockedAt: null,
      lastOpenedAt: null,
      createdAt: now()
    };
    db.profiles.push(profile);
    this.saveDb(db);
    await this.audit(actor, "profile.create", profile.id, { name });
    return profileDto(db.users, profile);
  }

  async updateProfile(actor, profileId, body) {
    const db = this.loadDb();
    const profile = db.profiles.find((item) => item.id === profileId);
    if (!profile) return null;
    applyProfileFields(profile, body);
    if (!profile.name) throw new Error("Nome vazio");
    this.saveDb(db);
    await this.audit(actor, "profile.update", profile.id, { name: profile.name });
    return profileDto(db.users, profile);
  }

  async deleteProfile(actor, profileId) {
    const db = this.loadDb();
    const profile = db.profiles.find((item) => item.id === profileId);
    if (!profile) return false;
    db.profiles = db.profiles.filter((item) => item.id !== profileId);
    this.saveDb(db);
    await this.audit(actor, "profile.delete", profile.id, { name: profile.name });
    return true;
  }

  async importProfiles(actor, rows) {
    const db = this.loadDb();
    const result = { created: 0, updated: 0, skipped: 0 };
    const changedProfiles = [];

    for (const rawRow of rows) {
      const incoming = profileFromImportRow(rawRow);
      if (!incoming.name) {
        result.skipped += 1;
        continue;
      }
      const existing = incoming.tiktokEmail
        ? db.profiles.find((profile) => normalizeEmail(profile.tiktokEmail) === incoming.tiktokEmail)
        : null;
      if (existing) {
        applyProfileFields(existing, incoming);
        result.updated += 1;
        changedProfiles.push(existing);
      } else {
        const profile = {
          id: id("prf"),
          name: incoming.name,
          tiktokEmail: incoming.tiktokEmail,
          mailboxEmail: incoming.mailboxEmail,
          squad: normalizeSquad(incoming.squad),
          startUrl: startUrlForSquad(incoming.squad),
          notes: incoming.notes,
          tags: incoming.tags,
          sessionState: "empty",
          lockedBy: null,
          lockedAt: null,
          lastOpenedAt: null,
          createdAt: now()
        };
        db.profiles.push(profile);
        result.created += 1;
        changedProfiles.push(profile);
      }
    }

    this.saveDb(db);
    await this.audit(actor, "profile.import", null, result);
    return {
      result,
      profiles: changedProfiles.map((profile) => profileDto(db.users, profile))
    };
  }

  async audit(user, action, targetId, meta = {}) {
    const db = this.loadDb();
    db.audit.unshift({
      id: id("aud"),
      at: now(),
      userId: user?.id || null,
      userName: user?.name || "sistema",
      action,
      targetId,
      meta
    });
    db.audit = db.audit.slice(0, 500);
    this.saveDb(db);
  }

  async listAudit() {
    const db = this.loadDb();
    return db.audit.slice(0, 100);
  }
}

module.exports = { JsonStore };
