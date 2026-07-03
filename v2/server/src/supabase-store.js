const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");
const {
  now,
  id,
  publicUser,
  profileDto,
  normalizeEmail,
  normalizeSquad,
  normalizeTags,
  applyProfileFields,
  profileFromImportRow,
  startUrlForSquad
} = require("./shared");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variavel ${name} ausente para Supabase.`);
  return value;
}

function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.created_at
  };
}

function userToRow(user) {
  return {
    id: user.id,
    name: user.name,
    email: normalizeEmail(user.email),
    role: user.role === "admin" ? "admin" : "operator"
  };
}

function profileFromRow(row) {
  if (!row) return null;
  const rawTags = Array.isArray(row.tags) ? row.tags : [];
  const squadTag = rawTags.find((tag) => /^squad:/i.test(String(tag || "")));
  const squad = normalizeSquad(squadTag ? String(squadTag).split(":")[1] : row.squad);
  return {
    id: row.id,
    name: row.name,
    tiktokEmail: row.tiktok_email || "",
    mailboxEmail: row.mailbox_email || "",
    squad,
    startUrl: row.start_url || startUrlForSquad(squad),
    notes: row.notes || "",
    tags: rawTags.filter((tag) => !/^squad:/i.test(String(tag || ""))),
    sessionState: row.session_state || "empty",
    lockedBy: row.locked_by || null,
    lockedAt: row.locked_at || null,
    lastOpenedAt: row.last_opened_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function profileToRow(profile) {
  const squad = normalizeSquad(profile.squad);
  const tags = normalizeTags(profile.tags).filter((tag) => !/^squad:/i.test(String(tag || "")));
  return {
    id: profile.id,
    name: profile.name,
    tiktok_email: normalizeEmail(profile.tiktokEmail) || null,
    mailbox_email: normalizeEmail(profile.mailboxEmail) || null,
    notes: String(profile.notes || ""),
    tags: [...tags, `squad:${squad}`],
    session_state: profile.sessionState || "empty",
    locked_by: profile.lockedBy || null,
    locked_at: profile.lockedAt || null,
    last_opened_at: profile.lastOpenedAt || null,
    created_at: profile.createdAt || now(),
    updated_at: profile.updatedAt || now()
  };
}

function auditFromRow(row) {
  return {
    id: row.id,
    at: row.at,
    userId: row.user_id,
    userName: row.user_name,
    action: row.action,
    targetId: row.target_id,
    meta: row.meta || {}
  };
}

class SupabaseStore {
  constructor() {
    this.mode = "supabase";
    const url = process.env.V2_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceKey = process.env.V2_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const anonKey = process.env.V2_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || serviceKey;
    if (!url || !serviceKey) throw new Error("Supabase exige V2_SUPABASE_URL e V2_SUPABASE_SERVICE_ROLE_KEY.");
    this.admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    this.auth = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }

  async health() {
    const { error } = await this.admin.from("app_users").select("id", { count: "exact", head: true });
    if (error) throw error;
    return { store: this.mode };
  }

  async login(email, password) {
    const { data, error } = await this.auth.auth.signInWithPassword({
      email: normalizeEmail(email),
      password: String(password || "")
    });
    if (error || !data.session?.access_token || !data.user) return null;
    const user = await this.findUser(data.user.id, data.user.email);
    if (!user) {
      const authError = new Error("Usuario autenticado, mas sem permissao no app.");
      authError.status = 403;
      throw authError;
    }
    await this.audit(user, "auth.login", user.id);
    return { token: data.session.access_token, user: publicUser(user) };
  }

  async currentUser(token) {
    if (!token) return null;
    const { data, error } = await this.admin.auth.getUser(token);
    if (error || !data.user) return null;
    const user = await this.findUser(data.user.id, data.user.email);
    return user ? publicUser(user) : null;
  }

  async findUser(idValue, emailValue) {
    let query = this.admin.from("app_users").select("*");
    if (idValue) query = query.eq("id", idValue);
    else query = query.eq("email", normalizeEmail(emailValue));
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (data) return userFromRow(data);
    if (!emailValue) return null;
    const { data: byEmail, error: emailError } = await this.admin
      .from("app_users")
      .select("*")
      .eq("email", normalizeEmail(emailValue))
      .maybeSingle();
    if (emailError) throw emailError;
    return userFromRow(byEmail);
  }

  async listUsers() {
    const { data, error } = await this.admin
      .from("app_users")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data || []).map(userFromRow).map(publicUser);
  }

  async createUser(actor, body) {
    const name = String(body.name || "").trim();
    const email = normalizeEmail(body.email);
    if (!name || !email) throw new Error("Nome e e-mail sao obrigatorios");
    const temporaryPassword = String(body.password || "").trim() || crypto.randomBytes(9).toString("base64url");
    const role = body.role === "admin" ? "admin" : "operator";
    const { data: createdAuth, error: authError } = await this.admin.auth.admin.createUser({
      email,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: { name, role }
    });
    if (authError) throw authError;
    const user = {
      id: createdAuth.user.id,
      name,
      email,
      role
    };
    const { data, error } = await this.admin
      .from("app_users")
      .insert(userToRow(user))
      .select("*")
      .single();
    if (error) throw error;
    const saved = userFromRow(data);
    await this.audit(actor, "user.create", saved.id, { email: saved.email, role: saved.role });
    return { user: publicUser(saved), temporaryPassword };
  }

  async usersForProfiles() {
    const { data, error } = await this.admin.from("app_users").select("*");
    if (error) throw error;
    return (data || []).map(userFromRow);
  }

  async listProfiles() {
    const [{ data, error }, users] = await Promise.all([
      this.admin.from("profiles").select("*").order("squad", { ascending: true }).order("name", { ascending: true }),
      this.usersForProfiles()
    ]);
    if (error) throw error;
    return (data || []).map(profileFromRow).map((profile) => profileDto(users, profile));
  }

  async getProfile(profileId) {
    const [{ data, error }, users] = await Promise.all([
      this.admin.from("profiles").select("*").eq("id", profileId).maybeSingle(),
      this.usersForProfiles()
    ]);
    if (error) throw error;
    return data ? profileDto(users, profileFromRow(data)) : null;
  }

  async saveProfile(profile) {
    const { data, error } = await this.admin
      .from("profiles")
      .upsert(profileToRow(profile))
      .select("*")
      .single();
    if (error) throw error;
    const users = await this.usersForProfiles();
    return profileDto(users, profileFromRow(data));
  }

  async createProfile(actor, body) {
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
      tags: normalizeTags(body.tags),
      sessionState: "empty",
      lockedBy: null,
      lockedAt: null,
      lastOpenedAt: null,
      createdAt: now(),
      updatedAt: now()
    };
    const saved = await this.saveProfile(profile);
    await this.audit(actor, "profile.create", saved.id, { name: saved.name });
    return saved;
  }

  async updateProfile(actor, profileId, body) {
    const profile = await this.getProfile(profileId);
    if (!profile) return null;
    applyProfileFields(profile, body);
    if (!profile.name) throw new Error("Nome vazio");
    const saved = await this.saveProfile(profile);
    await this.audit(actor, "profile.update", saved.id, { name: saved.name });
    return saved;
  }

  async deleteProfile(actor, profileId) {
    const profile = await this.getProfile(profileId);
    if (!profile) return false;
    const { error } = await this.admin.from("profiles").delete().eq("id", profileId);
    if (error) throw error;
    await this.audit(actor, "profile.delete", profile.id, { name: profile.name });
    return true;
  }

  async importProfiles(actor, rows) {
    const result = { created: 0, updated: 0, skipped: 0 };
    const changedProfiles = [];

    for (const rawRow of rows) {
      const incoming = profileFromImportRow(rawRow);
      if (!incoming.name) {
        result.skipped += 1;
        continue;
      }
      let existing = null;
      if (incoming.tiktokEmail) {
        const { data, error } = await this.admin
          .from("profiles")
          .select("*")
          .eq("tiktok_email", incoming.tiktokEmail)
          .maybeSingle();
        if (error) throw error;
        existing = profileFromRow(data);
      }
      if (existing) {
        applyProfileFields(existing, incoming);
        changedProfiles.push(await this.saveProfile(existing));
        result.updated += 1;
      } else {
        changedProfiles.push(await this.createProfile(actor, incoming));
        result.created += 1;
      }
    }

    await this.audit(actor, "profile.import", null, result);
    return { result, profiles: changedProfiles };
  }

  async audit(user, action, targetId, meta = {}) {
    const row = {
      id: id("aud"),
      at: now(),
      user_id: user?.id || null,
      user_name: user?.name || "sistema",
      action,
      target_id: targetId || null,
      meta
    };
    const { error } = await this.admin.from("audit").insert(row);
    if (error) throw error;
  }

  async listAudit() {
    const { data, error } = await this.admin
      .from("audit")
      .select("*")
      .order("at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return (data || []).map(auditFromRow);
  }
}

module.exports = { SupabaseStore };
