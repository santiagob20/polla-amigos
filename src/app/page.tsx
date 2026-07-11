"use client";

import React, { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  collection,
  query,
  onSnapshot,
  orderBy,
  doc,
  setDoc,
  getDocs,
  getDoc,
  writeBatch,
  deleteDoc,
  where
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { calculatePoints, computeCumulativePoints, type CumulativeMatch } from "@/lib/scoreCalculator";
import { getFlagUrl, availableTeams } from "@/lib/flags";
import worldCupData from "./worldcup2026.json";

// Interfaces
interface Match {
  id: string;
  round: string;
  date: string;
  time: string;
  team1: string;
  team2: string;
  group: string | null;
  ground: string;
  num: number;
  result: { goals1: number; goals2: number; isFinal?: boolean } | null;
}

interface Prediction {
  id: string;
  userId: string;
  matchId: string;
  goals1: number;
  goals2: number;
  points: number;
  /** Acumulado del usuario ANTES de este partido (solo partidos finalizados). */
  prevPoints?: number;
  /** Acumulado DESPUÉS de este partido = prevPoints + points. `null` hasta que el partido finaliza. */
  afterMatchPoints?: number | null;
}

interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  points: number;
  isAdmin?: boolean;
  groupIds?: string[];
}

interface Group {
  id: string;
  name: string;
  code: string;
  createdAt: any;
  createdBy: string;
  admins?: string[];
}

function getMatchStartDate(match: Match): Date {
  try {
    const timeClean = match.time.replace("UTC", "").trim();
    const parts = timeClean.split(" ");
    const timePart = parts[0]; // "13:00"
    const offsetPart = parts[1] || "-5"; // default offset

    let offsetFormatted = "";
    if (offsetPart.startsWith("-") || offsetPart.startsWith("+")) {
      const sign = offsetPart.substring(0, 1);
      const val = offsetPart.substring(1);
      const valNum = Number(val);
      const hoursStr = String(valNum).padStart(2, "0");
      offsetFormatted = `${sign}${hoursStr}:00`;
    } else {
      const valNum = Number(offsetPart);
      if (!isNaN(valNum)) {
        const sign = valNum >= 0 ? "+" : "-";
        const hoursStr = String(Math.abs(valNum)).padStart(2, "0");
        offsetFormatted = `${sign}${hoursStr}:00`;
      } else {
        offsetFormatted = "-05:00";
      }
    }

    const isoString = `${match.date}T${timePart}:00${offsetFormatted}`;
    const date = new Date(isoString);
    if (!isNaN(date.getTime())) {
      return date;
    }
  } catch (e) {
    console.error("Error parsing match date:", e);
  }
  return new Date(match.date);
}

/**
 * Muestra el desglose acumulado de una predicción: cuántos puntos llevaba el
 * usuario ANTES del partido, los que sumó en él, y cómo quedó DESPUÉS.
 * Si el partido aún no finaliza, `afterMatchPoints` es null y se muestra un
 * total provisional (prevPoints + estimado en vivo).
 */
function PointsBreakdown({
  prevPoints,
  matchPoints,
  afterMatchPoints,
  isLive,
}: {
  prevPoints?: number;
  matchPoints: number;
  afterMatchPoints?: number | null;
  isLive?: boolean;
}) {
  const prev = prevPoints ?? 0;
  const provisional = afterMatchPoints == null;
  const after = provisional ? prev + matchPoints : afterMatchPoints;
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-semibold whitespace-nowrap">
      <span>Antes <span className="text-slate-300 font-bold tabular-nums">{prev}</span></span>
      <span className="text-slate-600">·</span>
      <span className={matchPoints > 0 ? "text-emerald-400 font-bold" : "text-slate-500 font-bold"}>
        +{matchPoints}
      </span>
      <span className="text-slate-600">·</span>
      <span>
        Después{" "}
        <span className={`font-bold tabular-nums ${provisional ? "text-amber-400" : "text-emerald-400"}`}>
          {after}
        </span>
        {provisional && isLive ? " (prov.)" : ""}
      </span>
    </div>
  );
}

/**
 * Construye la lista de partidos para el cálculo acumulado, asignando a cada
 * uno su índice cronológico (kickoff, luego número de partido como desempate).
 */
function buildCumulativeMatches(ms: Match[]): CumulativeMatch[] {
  const sorted = [...ms].sort((a, b) => {
    const dateA = getMatchStartDate(a).getTime();
    const dateB = getMatchStartDate(b).getTime();
    if (dateA !== dateB) return dateA - dateB;
    return a.num - b.num;
  });
  return sorted.map((m, i) => ({
    id: m.id,
    order: i,
    group: m.group,
    result: m.result,
  }));
}

function hasMatchStarted(match: Match): boolean {
  const kickoffPassed = Date.now() >= getMatchStartDate(match).getTime();
  if (kickoffPassed) {
    return true;
  }
  // Trust definitive final results even if kickoff metadata and local clock disagree.
  return match.result != null && match.result.isFinal !== false;
}

function isMatchLive(match: Match): boolean {
  return hasMatchStarted(match) && (match.result == null || match.result.isFinal === false);
}

// Only hides matches from PREVIOUS days, not today's matches (even if they already started/finished)
function isFromPreviousDay(match: Match): boolean {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayStr = `${yyyy}-${mm}-${dd}`;
  return match.date < todayStr;
}

function isArchivedMatch(match: Match): boolean {
  if (isFromPreviousDay(match)) {
    return true;
  }
  if (match.result != null && match.result.isFinal !== false) {
    return true;
  }
  return false;
}

function formatMatchDateTimeLocal(match: Match): string {
  const date = getMatchStartDate(match);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${year} • ${hours}:${minutes}`;
}

function formatRoundName(round: string): string {
  if (!round) return "";
  return round
    .replace(/Matchday\s+(\d+)/gi, "Día $1")
    .replace(/Round of 32/gi, "Ronda de 32")
    .replace(/Round of 16/gi, "Octavos")
    .replace(/Quarter-final/gi, "Cuartos")
    .replace(/Semi-final/gi, "Semifinal")
    .replace(/Match for third place/gi, "Tercer Puesto")
    .replace(/Final/gi, "Final");
}

const getTzAbbreviation = () => {
  try {
    return Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(new Date())
      .find(part => part.type === 'timeZoneName')?.value || "";
  } catch (e) {
    return "";
  }
};

const capitalizeFirstLetter = (str: string) => {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
};

const getPointsBadgeClass = (points: number): string => {
  if (points === 5 || points === 10) {
    return "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
  }
  if (points === 3 || points === 6) {
    return "bg-amber-500/10 text-amber-400 border border-amber-500/20";
  }
  if (points === 2 || points === 4) {
    return "bg-blue-500/10 text-blue-400 border border-blue-500/20";
  }
  if (points === 1) {
    return "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20";
  }
  return "bg-slate-800 text-slate-500 border border-transparent";
};

export default function Home() {
  const {
    user,
    profile,
    loading,
    savedAccounts,
    login,
    signup,
    logout,
    switchAccount,
    removeSavedAccount,
    resetPassword
  } = useAuth();

  // Ref for scrolling to the members section
  const membersSectionRef = React.useRef<HTMLDivElement>(null);

  // Auth state inputs
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  // Tabs: 'matches', 'leaderboard', 'admin'
  const [activeTab, setActiveTab] = useState<"matches" | "leaderboard" | "admin">("matches");

  // Data lists
  const [matches, setMatches] = useState<Match[]>([]);
  const [predictions, setPredictions] = useState<{ [matchId: string]: Prediction }>({});
  const [leaderboard, setLeaderboard] = useState<UserProfile[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  // Caching & inspection states
  const [viewingUserPredictions, setViewingUserPredictions] = useState<Prediction[]>([]);
  const [viewingUserPredsLoading, setViewingUserPredsLoading] = useState(false);
  const [matchesSyncing, setMatchesSyncing] = useState(false);
  const [lastMatchesUpdate, setLastMatchesUpdate] = useState<number | null>(null);
  const [syncCooldown, setSyncCooldown] = useState(0);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);

  // Filter & prediction draft inputs
  const [selectedRound, setSelectedRound] = useState<string>("Todos");
  const [hidePastMatches, setHidePastMatches] = useState(true);
  const [predictionDrafts, setPredictionDrafts] = useState<{ [matchId: string]: { goals1: string; goals2: string } }>({});
  const [savingMatches, setSavingMatches] = useState<{ [matchId: string]: boolean }>({});
  const [refreshingMatches, setRefreshingMatches] = useState<{ [matchId: string]: boolean }>({});

  // Admin inputs
  const [adminResults, setAdminResults] = useState<{ [matchId: string]: { goals1: string; goals2: string; isFinal: boolean } }>({});
  const [adminSaving, setAdminSaving] = useState<{ [matchId: string]: boolean }>({});
  const [adminSubTab, setAdminSubTab] = useState<"results" | "predictions" | "groups" | "users">("results");
  const [adminSelectedUserId, setAdminSelectedUserId] = useState<string>("");
  const [adminUserPredictions, setAdminUserPredictions] = useState<{ [matchId: string]: Prediction }>({});
  const [adminUserDrafts, setAdminUserDrafts] = useState<{ [matchId: string]: { goals1: string; goals2: string } }>({});
  const [adminSavingUserPreds, setAdminSavingUserPreds] = useState<{ [matchId: string]: boolean }>({});
  const [adminRecalculating, setAdminRecalculating] = useState(false);
  const [recalculatingUserId, setRecalculatingUserId] = useState<string | null>(null);
  const [adminSyncing, setAdminSyncing] = useState(false);
  const [hidePastMatchesAdmin, setHidePastMatchesAdmin] = useState(true);
  const [editingTeamsMatchId, setEditingTeamsMatchId] = useState<string | null>(null);
  const [editTeam1Draft, setEditTeam1Draft] = useState("");
  const [editTeam2Draft, setEditTeam2Draft] = useState("");
  const [savingTeams, setSavingTeams] = useState(false);

  // Groups states
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("global");
  const [inviteGroupCode, setInviteGroupCode] = useState<string | null>(null);
  const [inviteGroup, setInviteGroup] = useState<Group | null>(null);

  // Admin group creation inputs
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupCode, setNewGroupCode] = useState("");
  const [adminGroupSubTab, setAdminGroupSubTab] = useState<"list" | "create">("list");
  const [isJoining, setIsJoining] = useState(false);
  const [adminSelectedGroupId, setAdminSelectedGroupId] = useState<string>("");

  // User profile edit states
  const [showNameRestoreModal, setShowNameRestoreModal] = useState(false);
  const [newDisplayName, setNewDisplayName] = useState("");
  const [updatingOwnName, setUpdatingOwnName] = useState(false);
  const [isManualEditName, setIsManualEditName] = useState(false);

  // View user predictions modal states
  const [viewingUser, setViewingUser] = useState<UserProfile | null>(null);
  const [viewingUserFilter, setViewingUserFilter] = useState<"started" | "all">("started");

  // View team history modal states
  const [selectedTeamHistory, setSelectedTeamHistory] = useState<string | null>(null);

  // Auth Handler
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);
    try {
      if (isRegistering) {
        if (!name.trim()) {
          throw new Error("El nombre es obligatorio");
        }
        await signup(email, password, name.trim());
      } else {
        await login(email, password);
      }
    } catch (err: any) {
      console.error(err);
      let msg = "Ocurrió un error. Revisa tus credenciales.";
      if (err.code === "auth/email-already-in-use") msg = "El correo ya está registrado.";
      if (err.code === "auth/invalid-credential") msg = "Correo o contraseña incorrectos.";
      if (err.code === "auth/weak-password") msg = "La contraseña debe tener al menos 6 caracteres.";
      setAuthError(err.message || msg);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setAuthError("Por favor ingresa tu correo electrónico primero.");
      return;
    }
    setAuthLoading(true);
    setAuthError("");
    try {
      await resetPassword(email.trim());
      showToast(`Se ha enviado un correo para restablecer tu contraseña a: ${email.trim()}`, "success");
    } catch (err: any) {
      console.error(err);
      let msg = "Error al enviar el correo de restablecimiento.";
      if (err.code === "auth/invalid-email") msg = "Correo electrónico no válido.";
      if (err.code === "auth/user-not-found") msg = "No existe un usuario con este correo electrónico.";
      setAuthError(err.message || msg);
    } finally {
      setAuthLoading(false);
    }
  };

  // Real-time data sync
  useEffect(() => {
    if (!user) return;

    setDataLoading(true);
    setPredictions({});
    setPredictionDrafts({});

    // 1. Sync Matches (with caching for regular users)
    let unsubMatches = () => { };
    const isAdmin = profile?.isAdmin === true;
    const cacheTTL = 12 * 60 * 60 * 1000; // 12 hours

    const loadMatches = async () => {
      const todayStr = (() => {
        const t = new Date();
        return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
      })();

      const ACTIVE_TTL = 5 * 60 * 1000; // 5 min — today's live scores refresh quickly

      // --- Read caches ---
      let cachedArchived: Match[] | null = null;
      let cachedActive: Match[] | null = null;
      let lastCacheTime: number | null = null;

      try {
        const archivedStr = localStorage.getItem("polla_archived_cache");
        const activeStr = localStorage.getItem("polla_active_cache");
        const timeStr = localStorage.getItem("polla_active_cache_time"); // Unified cache timestamp

        if (archivedStr && activeStr && timeStr) {
          cachedArchived = JSON.parse(archivedStr) as Match[];
          cachedActive = JSON.parse(activeStr) as Match[];
          lastCacheTime = parseInt(timeStr, 10);
        }
      } catch (e) {
        console.error("Error reading matches cache:", e);
      }

      // Helper to execute a full fetch and update cache
      const performFullFetch = async () => {
        setMatchesSyncing(true);
        try {
          const qAll = query(collection(db, "matches"), orderBy("num", "asc"));
          const snap = await getDocs(qAll);
          const all: Match[] = [];
          snap.forEach((d) => all.push({ ...(d.data() as Match), id: d.id }));

          const archived = all.filter((m) => m.date < todayStr);
          const active = all.filter((m) => m.date >= todayStr);
          const now = Date.now();

          localStorage.setItem("polla_archived_cache", JSON.stringify(archived));
          localStorage.setItem("polla_archived_cache_time", String(now));
          localStorage.setItem("polla_active_cache", JSON.stringify(active));
          localStorage.setItem("polla_active_cache_time", String(now));
          setLastMatchesUpdate(now);
          setMatches(all);
        } catch (err) {
          console.error("Error performing full fetch:", err);
        } finally {
          setMatchesSyncing(false);
        }
      };

      // Helper to parse cache date string
      const getCacheDateStr = (timestamp: number): string => {
        const t = new Date(timestamp);
        return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
      };

      // Check cache validity and fetch accordingly
      if (cachedArchived && cachedActive && lastCacheTime) {
        try {
          // 1. Check if matches version was updated on the server since our cache
          const versionSnap = await getDoc(doc(db, "meta", "matches_version"));
          const serverUpdatedAt: number = versionSnap.exists() ? (versionSnap.data().updatedAt ?? 0) : 0;

          if (serverUpdatedAt > lastCacheTime) {
            // Admin made updates -> force full fetch to ensure we get everything (active or archived)
            await performFullFetch();
            return;
          }

          // 2. Check day transition
          const cacheDateStr = getCacheDateStr(lastCacheTime);
          if (cacheDateStr !== todayStr) {
            // The day has changed! Matches from yesterday/days since the last fetch are now archived.
            // We only fetch matches that were active at cacheDateStr to avoid loading the entire database.
            setMatchesSyncing(true);
            const qPartial = query(
              collection(db, "matches"),
              where("date", ">=", cacheDateStr)
            );
            const snap = await getDocs(qPartial);
            const fetchedMatches: Match[] = [];
            snap.forEach((d) => fetchedMatches.push({ ...(d.data() as Match), id: d.id }));

            const fetchedArchived = fetchedMatches.filter((m) => m.date < todayStr);
            const fetchedActive = fetchedMatches.filter((m) => m.date >= todayStr);

            // Filter out any matches from cachedArchived that are in fetchedArchived (to avoid duplicates/stale data)
            const fetchedArchivedIds = new Set(fetchedArchived.map((m) => m.id));
            const newArchived = [
              ...cachedArchived.filter((m) => !fetchedArchivedIds.has(m.id)),
              ...fetchedArchived
            ].sort((a, b) => a.num - b.num);

            const now = Date.now();
            localStorage.setItem("polla_archived_cache", JSON.stringify(newArchived));
            localStorage.setItem("polla_archived_cache_time", String(now));
            localStorage.setItem("polla_active_cache", JSON.stringify(fetchedActive));
            localStorage.setItem("polla_active_cache_time", String(now));
            setLastMatchesUpdate(now);

            const merged = [...newArchived, ...fetchedActive].sort((a, b) => a.num - b.num);
            setMatches(merged);
            setMatchesSyncing(false);
            return;
          }

          // 3. Regular active TTL check (same day)
          if (Date.now() - lastCacheTime > ACTIVE_TTL) {
            // Active matches expired but day is the same -> fetch today's and future matches
            setMatchesSyncing(true);
            const qActive = query(
              collection(db, "matches"),
              where("date", ">=", todayStr)
            );
            const snap = await getDocs(qActive);
            const freshActive: Match[] = [];
            snap.forEach((d) => freshActive.push({ ...(d.data() as Match), id: d.id }));
            freshActive.sort((a, b) => a.num - b.num);

            const now = Date.now();
            localStorage.setItem("polla_active_cache", JSON.stringify(freshActive));
            localStorage.setItem("polla_active_cache_time", String(now));
            setLastMatchesUpdate(now);

            const merged = [...cachedArchived, ...freshActive].sort((a, b) => a.num - b.num);
            setMatches(merged);
            setMatchesSyncing(false);
            return;
          }

          // Both caches valid and day matches -> load from cache (0 Firestore reads)
          const merged = [...cachedArchived, ...cachedActive].sort((a, b) => a.num - b.num);
          setMatches(merged);
          setLastMatchesUpdate(lastCacheTime);
        } catch (e) {
          console.warn("Could not validate cache, falling back to cache contents:", e);
          const merged = [...cachedArchived, ...cachedActive].sort((a, b) => a.num - b.num);
          setMatches(merged);
          setLastMatchesUpdate(lastCacheTime);
        }
      } else {
        // Caches don't exist -> do a full fetch
        await performFullFetch();
      }
    };

    if (isAdmin) {
      const qMatches = query(collection(db, "matches"), orderBy("num", "asc"));
      unsubMatches = onSnapshot(qMatches, (snapshot) => {
        const changes = snapshot.docChanges();

        // On the initial load all docs arrive as "added" — build the full list once
        if (changes.length === snapshot.docs.length && changes.every(c => c.type === "added")) {
          const list: Match[] = [];
          const adminDrafts: { [matchId: string]: { goals1: string; goals2: string; isFinal: boolean } } = {};
          snapshot.forEach((doc) => {
            const m = doc.data() as Match;
            list.push({ ...m, id: doc.id });
            adminDrafts[doc.id] = m.result
              ? { goals1: String(m.result.goals1), goals2: String(m.result.goals2), isFinal: m.result.isFinal ?? true }
              : { goals1: "", goals2: "", isFinal: true };
          });
          setMatches(list);
          setAdminResults((prev) => ({ ...prev, ...adminDrafts }));
          return;
        }

        // Subsequent events: patch only the changed docs
        const adminDraftPatch: { [matchId: string]: { goals1: string; goals2: string; isFinal: boolean } } = {};
        setMatches(prevMatches => {
          let updated = [...prevMatches];
          changes.forEach(change => {
            const m = { ...change.doc.data() as Match, id: change.doc.id };
            if (change.type === "added" || change.type === "modified") {
              const idx = updated.findIndex(x => x.id === m.id);
              if (idx >= 0) updated[idx] = m; else updated.push(m);
              adminDraftPatch[m.id] = m.result
                ? { goals1: String(m.result.goals1), goals2: String(m.result.goals2), isFinal: m.result.isFinal ?? true }
                : { goals1: "", goals2: "", isFinal: true };
            } else if (change.type === "removed") {
              updated = updated.filter(x => x.id !== m.id);
            }
          });
          return updated.sort((a, b) => a.num - b.num);
        });
        if (Object.keys(adminDraftPatch).length > 0) {
          setAdminResults(prev => ({ ...prev, ...adminDraftPatch }));
        }
      }, (err) => {
        if (err.code !== "permission-denied") console.error("Admin matches listener error:", err);
      });
    } else {
      loadMatches();
    }

    // 2. Sync Current User's Predictions (Scoped to current user)
    const qPreds = query(
      collection(db, "predictions"),
      where("userId", "==", user.uid)
    );
    const unsubPreds = onSnapshot(qPreds, (snapshot) => {
      const userPreds: { [matchId: string]: Prediction } = {};
      snapshot.forEach((doc) => {
        const data = doc.data() as Prediction;
        userPreds[data.matchId] = data;
      });
      setPredictions(userPreds);

      // Initialize prediction drafts with existing values
      const drafts: { [matchId: string]: { goals1: string; goals2: string } } = {};
      Object.keys(userPreds).forEach((matchId) => {
        drafts[matchId] = {
          goals1: String(userPreds[matchId].goals1),
          goals2: String(userPreds[matchId].goals2),
        };
      });
      setPredictionDrafts(drafts);
    }, (err) => {
      if (err.code !== "permission-denied") console.error("Predictions listener error:", err);
    });

    // 3. Sync Leaderboard / Users
    const qUsers = query(collection(db, "users"), orderBy("points", "desc"));
    const unsubUsers = onSnapshot(qUsers, (snapshot) => {
      const list: UserProfile[] = [];
      snapshot.forEach((doc) => {
        list.push(doc.data() as UserProfile);
      });
      setLeaderboard(list);
      setDataLoading(false);
    }, (err) => {
      if (err.code !== "permission-denied") console.error("Users listener error:", err);
      setDataLoading(false);
    });

    // 4. Sync Groups
    const qGroups = query(collection(db, "groups"), orderBy("name", "asc"));
    const unsubGroups = onSnapshot(qGroups, (snapshot) => {
      const list: Group[] = [];
      snapshot.forEach((doc) => {
        list.push({ ...doc.data() as Group, id: doc.id });
      });
      setGroups(list);
    }, (err) => {
      if (err.code !== "permission-denied") console.error("Groups listener error:", err);
    });

    return () => {
      unsubMatches();
      unsubPreds();
      unsubUsers();
      unsubGroups();
    };
  }, [user, profile?.isAdmin]);

  // Sync selected user's predictions for admin edit
  useEffect(() => {
    if (!user || !profile?.isAdmin || !adminSelectedUserId) {
      setAdminUserPredictions({});
      setAdminUserDrafts({});
      return;
    }

    const qPreds = query(
      collection(db, "predictions"),
      where("userId", "==", adminSelectedUserId)
    );
    const unsubAdminUserPreds = onSnapshot(qPreds, (snapshot) => {
      const userPreds: { [matchId: string]: Prediction } = {};
      const drafts: { [matchId: string]: { goals1: string; goals2: string } } = {};

      snapshot.forEach((doc) => {
        const data = doc.data() as Prediction;
        userPreds[data.matchId] = data;
        drafts[data.matchId] = {
          goals1: String(data.goals1),
          goals2: String(data.goals2),
        };
      });

      setAdminUserPredictions(userPreds);
      setAdminUserDrafts(drafts);
    }, (err) => {
      if (err.code !== "permission-denied") console.error("Admin user predictions listener error:", err);
    });

    return () => {
      unsubAdminUserPreds();
    };
  }, [user, profile?.isAdmin, adminSelectedUserId]);

  // Load predictions for viewingUser when modal opens
  useEffect(() => {
    if (!viewingUser) {
      setViewingUserPredictions([]);
      return;
    }

    setViewingUserPredsLoading(true);
    const q = query(
      collection(db, "predictions"),
      where("userId", "==", viewingUser.uid)
    );

    getDocs(q)
      .then((snapshot) => {
        const predsList: Prediction[] = [];
        snapshot.forEach((doc) => {
          predsList.push(doc.data() as Prediction);
        });
        setViewingUserPredictions(predsList);
      })
      .catch((err) => {
        console.error("Error fetching viewing user predictions:", err);
      })
      .finally(() => {
        setViewingUserPredsLoading(false);
      });
  }, [viewingUser]);

  // Handle sync button cooldown countdown
  useEffect(() => {
    const checkCooldown = () => {
      try {
        const lastSync = localStorage.getItem("polla_last_manual_sync");
        if (lastSync) {
          const elapsed = Date.now() - parseInt(lastSync, 10);
          const remaining = Math.max(0, Math.ceil((30000 - elapsed) / 1000));
          setSyncCooldown(remaining);
          return remaining;
        }
      } catch (e) {
        console.error("Error reading sync cooldown:", e);
      }
      setSyncCooldown(0);
      return 0;
    };

    const initialRemaining = checkCooldown();

    if (initialRemaining > 0) {
      const interval = setInterval(() => {
        const remaining = checkCooldown();
        if (remaining <= 0) {
          clearInterval(interval);
        }
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [matchesSyncing]);

  // Handle Toast notifications auto-dismiss
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => {
        setToast(null);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const showToast = (message: string, type: "success" | "error" | "info" = "info") => {
    setToast({ message, type });
  };

  // Force non-superadmins to the groups sub-tab when visiting the admin panel
  useEffect(() => {
    if (activeTab === "admin" && !profile?.isAdmin && adminSubTab !== "groups") {
      setAdminSubTab("groups");
    }
  }, [activeTab, profile?.isAdmin, adminSubTab]);

  // Load group query parameter on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const groupCode = params.get("group");
      if (groupCode) {
        setInviteGroupCode(groupCode);
        setIsRegistering(true);
      }
    }
  }, []);

  // Fetch group corresponding to the inviteGroupCode
  useEffect(() => {
    if (!inviteGroupCode) return;
    const q = query(collection(db, "groups"));
    const unsub = onSnapshot(q, (snapshot) => {
      let found: Group | null = null;
      snapshot.forEach((doc) => {
        const g = doc.data() as Group;
        if (g.code === inviteGroupCode) {
          found = { ...g, id: doc.id };
        }
      });
      setInviteGroup(found);
    }, (err) => {
      if (err.code !== "permission-denied") console.error("Invite group listener error:", err);
    });
    return () => unsub();
  }, [inviteGroupCode]);

  // Auto-join group if user is authenticated and inviteGroup is loaded
  useEffect(() => {
    if (!user || !profile || !inviteGroup) return;

    const currentGroups = profile.groupIds || [];
    if (!currentGroups.includes(inviteGroup.id)) {
      const updatedGroups = [...currentGroups, inviteGroup.id];
      setDoc(doc(db, "users", user.uid), { groupIds: updatedGroups }, { merge: true })
        .then(() => {
          alert(`¡Te has unido exitosamente al grupo: ${inviteGroup.name}!`);
          setInviteGroupCode(null);
          setInviteGroup(null);
          if (typeof window !== "undefined") {
            const url = new URL(window.location.href);
            url.searchParams.delete("group");
            window.history.replaceState({}, document.title, url.toString());
          }
        })
        .catch(err => {
          console.error("Error joining group:", err);
        });
    } else {
      // Already joined, clear invite state
      setInviteGroupCode(null);
      setInviteGroup(null);
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("group");
        window.history.replaceState({}, document.title, url.toString());
      }
    }
  }, [user, profile, inviteGroup]);

  // Scroll to members section when a group is selected to view members
  useEffect(() => {
    if (adminSelectedGroupId) {
      setTimeout(() => {
        membersSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    }
  }, [adminSelectedGroupId]);

  const saveUserPredictionByAdmin = async (matchId: string) => {
    if (!user || !profile?.isAdmin || !adminSelectedUserId) return;
    const draft = adminUserDrafts[matchId];
    if (!draft || draft.goals1 === "" || draft.goals2 === "") return;

    const g1 = parseInt(draft.goals1);
    const g2 = parseInt(draft.goals2);
    if (isNaN(g1) || isNaN(g2)) return;

    setAdminSavingUserPreds(prev => ({ ...prev, [matchId]: true }));
    try {
      const predId = `${adminSelectedUserId}_${matchId}`;
      const match = matches.find(m => m.id === matchId);

      let pts = 0;
      if (match?.result) {
        pts = calculatePoints(g1, g2, match.result.goals1, match.result.goals2, match.group);
      }

      await setDoc(doc(db, "predictions", predId), {
        id: predId,
        userId: adminSelectedUserId,
        matchId: matchId,
        goals1: g1,
        goals2: g2,
        points: pts
      });

      const userPredsSnap = await getDocs(
        query(collection(db, "predictions"), where("userId", "==", adminSelectedUserId))
      );
      let totalPoints = 0;
      userPredsSnap.forEach((pDoc) => {
        const pred = pDoc.data() as Prediction;
        const match = matches.find(m => m.id === pred.matchId);
        const isFinal = match?.result ? (match.result.isFinal ?? true) : false;
        if (isFinal) {
          totalPoints += pred.points || 0;
        }
      });

      await setDoc(doc(db, "users", adminSelectedUserId), {
        points: totalPoints
      }, { merge: true });

    } catch (err) {
      console.error("Error saving user prediction by admin:", err);
      alert("Error al guardar la predicción del usuario.");
    } finally {
      setAdminSavingUserPreds(prev => ({ ...prev, [matchId]: false }));
    }
  };

  // Refresh live match score by matchId (to save Firestore reads)
  const refreshLiveMatchScore = async (matchId: string) => {
    if (refreshingMatches[matchId]) return;
    setRefreshingMatches(prev => ({ ...prev, [matchId]: true }));
    try {
      const matchSnap = await getDoc(doc(db, "matches", matchId));
      if (matchSnap.exists()) {
        const freshMatchData = { ...matchSnap.data(), id: matchSnap.id } as Match;

        // 1. Update React state
        setMatches(prevMatches =>
          prevMatches.map(m => (m.id === matchId ? freshMatchData : m))
        );

        // 2. Sync local storage caches to keep client in sync
        try {
          const archivedStr = localStorage.getItem("polla_archived_cache");
          const activeStr = localStorage.getItem("polla_active_cache");
          const todayStr = (() => {
            const t = new Date();
            return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
          })();

          const isArchived = freshMatchData.date < todayStr;

          if (archivedStr) {
            let archived = JSON.parse(archivedStr) as Match[];
            if (isArchived) {
              if (archived.some(m => m.id === matchId)) {
                archived = archived.map(m => (m.id === matchId ? freshMatchData : m));
              } else {
                archived.push(freshMatchData);
              }
            } else {
              archived = archived.filter(m => m.id !== matchId);
            }
            localStorage.setItem("polla_archived_cache", JSON.stringify(archived));
          }

          if (activeStr) {
            let active = JSON.parse(activeStr) as Match[];
            if (!isArchived) {
              if (active.some(m => m.id === matchId)) {
                active = active.map(m => (m.id === matchId ? freshMatchData : m));
              } else {
                active.push(freshMatchData);
              }
            } else {
              active = active.filter(m => m.id !== matchId);
            }
            localStorage.setItem("polla_active_cache", JSON.stringify(active));
          }
        } catch (e) {
          console.error("Error updating local storage cache for single match:", e);
        }
      }
    } catch (err) {
      console.error("Error refreshing match score:", err);
    } finally {
      setRefreshingMatches(prev => ({ ...prev, [matchId]: false }));
    }
  };

  // Helper for manual matching synchronization (updates both cache segments)
  const forceSyncMatches = async () => {
    if (matchesSyncing) return;

    // Check if cooldown is active
    try {
      const lastSync = localStorage.getItem("polla_last_manual_sync");
      if (lastSync) {
        const elapsed = Date.now() - parseInt(lastSync, 10);
        if (elapsed < 30000) {
          const remaining = Math.ceil((30000 - elapsed) / 1000);
          showToast(`Por favor espera ${remaining} segundos antes de sincronizar nuevamente.`, "info");
          return;
        }
      }
    } catch (e) {
      console.error("Error reading last manual sync time:", e);
    }

    const todayStr = (() => {
      const t = new Date();
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    })();

    setMatchesSyncing(true);
    try {
      const qMatches = query(collection(db, "matches"), orderBy("num", "asc"));
      const snapshot = await getDocs(qMatches);
      const list: Match[] = [];
      snapshot.forEach((d) => list.push({ ...d.data() as Match, id: d.id }));

      // Re-split and persist both cache segments
      const archived = list.filter(m => m.date < todayStr);
      const active = list.filter(m => m.date >= todayStr);
      const now = Date.now();
      localStorage.setItem("polla_archived_cache", JSON.stringify(archived));
      localStorage.setItem("polla_archived_cache_time", String(now));
      localStorage.setItem("polla_active_cache", JSON.stringify(active));
      localStorage.setItem("polla_active_cache_time", String(now));
      localStorage.setItem("polla_last_manual_sync", String(now));
      setMatches(list);
      setLastMatchesUpdate(now);
      showToast("¡Partidos sincronizados desde la base de datos correctamente!", "success");
    } catch (err) {
      console.error("Error manual syncing matches:", err);
      showToast("Error al sincronizar partidos. Por favor intenta de nuevo.", "error");
    } finally {
      setMatchesSyncing(false);
    }
  };

  // Handle saving prediction
  const savePrediction = async (matchId: string) => {
    if (!user) return;
    const draft = predictionDrafts[matchId];
    if (!draft || draft.goals1 === "" || draft.goals2 === "") return;

    const g1 = parseInt(draft.goals1);
    const g2 = parseInt(draft.goals2);
    if (isNaN(g1) || isNaN(g2)) return;

    setSavingMatches(prev => ({ ...prev, [matchId]: true }));
    try {
      const match = matches.find(m => m.id === matchId);
      if (match && hasMatchStarted(match)) {
        alert("El partido ya ha iniciado o finalizado. No se puede guardar ni modificar el pronóstico.");
        return;
      }

      const predId = `${user.uid}_${matchId}`;
      let pts = 0;
      if (match?.result) {
        pts = calculatePoints(g1, g2, match.result.goals1, match.result.goals2, match.group);
      }

      await setDoc(doc(db, "predictions", predId), {
        id: predId,
        userId: user.uid,
        matchId: matchId,
        goals1: g1,
        goals2: g2,
        points: pts
      });
    } catch (err) {
      console.error("Error saving prediction:", err);
    } finally {
      setSavingMatches(prev => ({ ...prev, [matchId]: false }));
    }
  };

  // Recompute the running cumulative points (prevPoints / afterMatchPoints) for
  // every prediction, walking each user's predictions in chronological order,
  // and persist both the per-prediction breakdown and each user's total.
  // The user total is taken from the afterMatchPoints of their last finished
  // match (== the running total), so the standing is fully explained by the chain.
  const persistCumulativeScores = async (matchesArr: Match[]) => {
    const predsSnap = await getDocs(collection(db, "predictions"));
    const preds: { id: string; data: Prediction }[] = [];
    const predInputs = predsSnap.docs.map((d) => {
      const data = d.data() as Prediction;
      preds.push({ id: d.id, data });
      return {
        id: d.id,
        userId: data.userId,
        matchId: data.matchId,
        goals1: data.goals1,
        goals2: data.goals2,
      };
    });

    const { byPrediction, userTotals } = computeCumulativePoints(
      predInputs,
      buildCumulativeMatches(matchesArr)
    );

    // Firestore caps a writeBatch at 500 operations. A full backfill rewrites
    // hundreds of predictions plus every user, so we commit in chunks. Users are
    // written last so that users.points always ends up reflecting the freshly
    // computed chain total (the afterMatchPoints of each user's last final match).
    const BATCH_LIMIT = 450;
    let batch = writeBatch(db);
    let opsInBatch = 0;
    const stageWrite = async (ref: ReturnType<typeof doc>, data: Record<string, unknown>, merge: boolean) => {
      if (merge) batch.set(ref, data, { merge: true });
      else batch.update(ref, data);
      opsInBatch++;
      if (opsInBatch >= BATCH_LIMIT) {
        await batch.commit();
        batch = writeBatch(db);
        opsInBatch = 0;
      }
    };

    for (const { id, data } of preds) {
      const cp = byPrediction.get(id);
      if (!cp) continue;
      const changed =
        data.points !== cp.points ||
        (data.prevPoints ?? null) !== cp.prevPoints ||
        (data.afterMatchPoints ?? null) !== cp.afterMatchPoints;
      if (changed) {
        await stageWrite(
          doc(db, "predictions", id),
          { points: cp.points, prevPoints: cp.prevPoints, afterMatchPoints: cp.afterMatchPoints },
          false
        );
      }
    }

    const usersSnap = await getDocs(collection(db, "users"));
    for (const uDoc of usersSnap.docs) {
      const uid = uDoc.id;
      if (uid && uid !== "undefined") {
        await stageWrite(doc(db, "users", uid), { points: userTotals.get(uid) || 0 }, true);
      }
    }

    if (opsInBatch > 0) {
      await batch.commit();
    }
  };

  // Fast path for the common case: one or more matches are finalized AT THE END
  // of the chronological chain. Because users.points already equals each user's
  // last afterMatchPoints, a new final match simply advances their total by the
  // points scored in it — no full re-read/rewrite of the whole chain needed.
  // Only the finalized matches' predictions (and the affected users) are touched.
  //
  // Returns false when it's NOT a clean append (out-of-order finalize), so the
  // caller falls back to the full persistCumulativeScores recompute. Editing an
  // already-final result must be handled by the caller (force fallback), since
  // that shifts the tail of the chain.
  const tryIncrementalFinalize = async (
    matchesArr: Match[],
    newlyFinalMatchIds: string[]
  ): Promise<boolean> => {
    const ordered = buildCumulativeMatches(matchesArr);
    const orderById = new Map(ordered.map((m) => [m.id, m.order]));
    const byId = new Map(ordered.map((m) => [m.id, m]));

    // Keep only the ids that are actually final now.
    const finalIds = newlyFinalMatchIds.filter((id) => {
      const m = byId.get(id);
      return m && m.result && m.result.isFinal !== false;
    });
    if (finalIds.length === 0) return true; // nothing points-relevant to persist

    finalIds.sort((a, b) => (orderById.get(a) ?? 0) - (orderById.get(b) ?? 0));

    // Highest chronological order among matches that were ALREADY final,
    // excluding the ones we're finalizing right now.
    const finalIdSet = new Set(finalIds);
    let maxExistingFinalOrder = -1;
    for (const m of ordered) {
      if (finalIdSet.has(m.id)) continue;
      if (m.result && m.result.isFinal !== false && m.order > maxExistingFinalOrder) {
        maxExistingFinalOrder = m.order;
      }
    }

    // Clean append only if every newly-final match sits after all existing finals.
    if ((orderById.get(finalIds[0]) ?? 0) <= maxExistingFinalOrder) return false;

    // Current user totals (== last afterMatchPoints) are the running start point.
    const usersSnap = await getDocs(collection(db, "users"));
    const runningByUser = new Map<string, number>();
    usersSnap.forEach((u) => runningByUser.set(u.id, (u.data().points as number) || 0));

    // Predictions for the finalized matches only ('in' supports up to 30 ids).
    type PredRow = { id: string; userId: string; matchId: string; goals1: number; goals2: number };
    const byUser = new Map<string, PredRow[]>();
    for (let i = 0; i < finalIds.length; i += 30) {
      const chunk = finalIds.slice(i, i + 30);
      const snap = await getDocs(query(collection(db, "predictions"), where("matchId", "in", chunk)));
      snap.forEach((d) => {
        const data = d.data() as Prediction;
        const row: PredRow = {
          id: d.id,
          userId: data.userId,
          matchId: data.matchId,
          goals1: data.goals1,
          goals2: data.goals2,
        };
        if (!byUser.has(row.userId)) byUser.set(row.userId, []);
        byUser.get(row.userId)!.push(row);
      });
    }

    const BATCH_LIMIT = 450;
    let batch = writeBatch(db);
    let ops = 0;
    const flush = async () => {
      if (ops >= BATCH_LIMIT) {
        await batch.commit();
        batch = writeBatch(db);
        ops = 0;
      }
    };

    const touchedUsers = new Set<string>();
    for (const [userId, preds] of byUser) {
      preds.sort((a, b) => (orderById.get(a.matchId) ?? 0) - (orderById.get(b.matchId) ?? 0));
      let running = runningByUser.get(userId) ?? 0;
      for (const p of preds) {
        const m = byId.get(p.matchId)!;
        const pts = calculatePoints(p.goals1, p.goals2, m.result!.goals1, m.result!.goals2, m.group);
        const prevPoints = running;
        running = running + pts;
        batch.update(doc(db, "predictions", p.id), { points: pts, prevPoints, afterMatchPoints: running });
        ops++;
        await flush();
      }
      runningByUser.set(userId, running);
      touchedUsers.add(userId);
    }

    // Users who scored nothing new (no prediction for the finalized matches) keep
    // their total untouched — no record is created for them (see design B).
    for (const userId of touchedUsers) {
      batch.set(doc(db, "users", userId), { points: runningByUser.get(userId) || 0 }, { merge: true });
      ops++;
      await flush();
    }

    if (ops > 0) await batch.commit();
    return true;
  };

  // Admin: Set Match Result and Update Scores
  const saveMatchResult = async (matchId: string) => {
    const draft = adminResults[matchId];
    if (!draft || draft.goals1 === "" || draft.goals2 === "") return;

    const rg1 = parseInt(draft.goals1);
    const rg2 = parseInt(draft.goals2);
    if (isNaN(rg1) || isNaN(rg2)) return;

    setAdminSaving(prev => ({ ...prev, [matchId]: true }));

    // Was this match already final before we touched it? Editing an existing
    // final result shifts the tail of the chain, so it forces the full recompute.
    const isFinalNow = draft.isFinal ?? true;
    const prevMatch = matches.find((m) => m.id === matchId);
    const wasAlreadyFinal = !!(prevMatch?.result && prevMatch.result.isFinal !== false);

    try {
      // 1. Update Match Doc
      const matchRef = doc(db, "matches", matchId);
      await setDoc(matchRef, {
        result: { goals1: rg1, goals2: rg2, isFinal: isFinalNow }
      }, { merge: true });

      // 2. Update the cumulative chain. Read matches fresh and overlay the result
      // we just wrote (in case the fresh read raced the write).
      const matchesSnap = await getDocs(collection(db, "matches"));
      const matchesArr: Match[] = matchesSnap.docs.map((d) => {
        const m = { ...(d.data() as Match), id: d.id };
        if (d.id === matchId) {
          m.result = { goals1: rg1, goals2: rg2, isFinal: isFinalNow };
        }
        return m;
      });

      // Fast path when finalizing a new match at the end of the chain; otherwise
      // (edit of an existing final, or out-of-order finalize) full recompute.
      let handled = false;
      if (isFinalNow && !wasAlreadyFinal) {
        handled = await tryIncrementalFinalize(matchesArr, [matchId]);
      }
      if (!handled) {
        await persistCumulativeScores(matchesArr);
      }

      // Bump matches_version so clients invalidate their active cache on next load
      await setDoc(doc(db, "meta", "matches_version"), { updatedAt: Date.now() }, { merge: true });

      alert("Resultado guardado y puntajes recalculados exitosamente.");
    } catch (err) {
      console.error("Error setting match result:", err);
      alert("Error al guardar resultado.");
    } finally {
      setAdminSaving(prev => ({ ...prev, [matchId]: false }));
    }
  };

  const recalculateAllScores = async () => {
    if (adminRecalculating) return;
    const confirmRecalc = window.confirm("¿Estás seguro de que deseas recalcular y actualizar en la base de datos los puntos de todos los usuarios y predicciones? Esto resolverá cualquier descuadre.");
    if (!confirmRecalc) return;

    setAdminRecalculating(true);
    try {
      const matchesSnap = await getDocs(collection(db, "matches"));
      const matchesArr: Match[] = matchesSnap.docs.map((d) => ({
        ...(d.data() as Match),
        id: d.id,
      }));

      await persistCumulativeScores(matchesArr);
      alert("¡Todos los puntajes de las predicciones y de los usuarios han sido recalculados y guardados con éxito en la base de datos!");
    } catch (err) {
      console.error("Error recalculating all scores:", err);
      alert("Error al recalcular todos los puntajes en Firestore.");
    } finally {
      setAdminRecalculating(false);
    }
  };

  // Admin: recompute the full cumulative chain for a SINGLE user. Walks only that
  // user's predictions in chronological order, so it fixes any drift between the
  // running breakdown (prevPoints / afterMatchPoints) and users.points — the
  // discrepancy the incremental fast-path can leave when matches finalize out of
  // order — without re-reading/rewriting every other participant's chain.
  const recalculateUserScores = async (target: UserProfile) => {
    if (!profile?.isAdmin || recalculatingUserId) return;
    const confirmRecalc = window.confirm(
      `¿Recalcular los puntos de ${target.displayName}? Se recorrerán sus predicciones en orden cronológico para corregir cualquier descuadre en su acumulado.`
    );
    if (!confirmRecalc) return;

    setRecalculatingUserId(target.uid);
    try {
      // Fresh matches so the chronological ordering and results are up to date.
      const matchesSnap = await getDocs(collection(db, "matches"));
      const matchesArr: Match[] = matchesSnap.docs.map((d) => ({
        ...(d.data() as Match),
        id: d.id,
      }));

      // Only this user's predictions (≤ one per match, well under any batch cap).
      const predsSnap = await getDocs(
        query(collection(db, "predictions"), where("userId", "==", target.uid))
      );
      const preds: { id: string; data: Prediction }[] = [];
      const predInputs = predsSnap.docs.map((d) => {
        const data = d.data() as Prediction;
        preds.push({ id: d.id, data });
        return {
          id: d.id,
          userId: data.userId,
          matchId: data.matchId,
          goals1: data.goals1,
          goals2: data.goals2,
        };
      });

      const { byPrediction, userTotals } = computeCumulativePoints(
        predInputs,
        buildCumulativeMatches(matchesArr)
      );

      const batch = writeBatch(db);
      let changedCount = 0;
      for (const { id, data } of preds) {
        const cp = byPrediction.get(id);
        if (!cp) continue;
        const changed =
          data.points !== cp.points ||
          (data.prevPoints ?? null) !== cp.prevPoints ||
          (data.afterMatchPoints ?? null) !== cp.afterMatchPoints;
        if (changed) {
          batch.update(doc(db, "predictions", id), {
            points: cp.points,
            prevPoints: cp.prevPoints,
            afterMatchPoints: cp.afterMatchPoints,
          });
          changedCount++;
        }
      }

      const newTotal = userTotals.get(target.uid) || 0;
      batch.set(doc(db, "users", target.uid), { points: newTotal }, { merge: true });
      await batch.commit();

      // The modal's prediction list is a one-off read (not a live subscription),
      // so refresh it — and the header total — in place. The leaderboard updates
      // itself through its users onSnapshot.
      const cpByMatchId = new Map(
        preds.map(({ id, data }) => [data.matchId, byPrediction.get(id)])
      );
      setViewingUserPredictions((prev) =>
        prev.map((p) => {
          const cp = cpByMatchId.get(p.matchId);
          if (!cp) return p;
          return {
            ...p,
            points: cp.points,
            prevPoints: cp.prevPoints,
            afterMatchPoints: cp.afterMatchPoints,
          };
        })
      );
      setViewingUser((prev) =>
        prev && prev.uid === target.uid ? { ...prev, points: newTotal } : prev
      );

      alert(
        `Puntos de ${target.displayName} recalculados. ${changedCount} predicción(es) actualizada(s). Total: ${newTotal} pts.`
      );
    } catch (err) {
      console.error("Error recalculating user scores:", err);
      alert("Error al recalcular los puntos de este usuario.");
    } finally {
      setRecalculatingUserId(null);
    }
  };

  const handleSaveTeams = async (matchId: string) => {
    if (!editTeam1Draft.trim() || !editTeam2Draft.trim()) {
      alert("Los nombres de los equipos no pueden estar vacíos.");
      return;
    }
    setSavingTeams(true);
    try {
      const matchRef = doc(db, "matches", matchId);
      await setDoc(matchRef, {
        team1: editTeam1Draft.trim(),
        team2: editTeam2Draft.trim()
      }, { merge: true });

      // Update local state
      setMatches(prevMatches =>
        prevMatches.map(m => (m.id === matchId ? { ...m, team1: editTeam1Draft.trim(), team2: editTeam2Draft.trim() } : m))
      );

      // Sync local storage caches
      try {
        const archivedStr = localStorage.getItem("polla_archived_cache");
        const activeStr = localStorage.getItem("polla_active_cache");
        if (archivedStr) {
          const archived = JSON.parse(archivedStr) as Match[];
          const updated = archived.map(m => m.id === matchId ? { ...m, team1: editTeam1Draft.trim(), team2: editTeam2Draft.trim() } : m);
          localStorage.setItem("polla_archived_cache", JSON.stringify(updated));
        }
        if (activeStr) {
          const active = JSON.parse(activeStr) as Match[];
          const updated = active.map(m => m.id === matchId ? { ...m, team1: editTeam1Draft.trim(), team2: editTeam2Draft.trim() } : m);
          localStorage.setItem("polla_active_cache", JSON.stringify(updated));
        }
      } catch (e) {
        console.error("Error updating local storage cache for team edit:", e);
      }

      // Notify clients their active cache is stale
      await setDoc(doc(db, "meta", "matches_version"), { updatedAt: Date.now() }, { merge: true });

      setEditingTeamsMatchId(null);
      alert("Equipos del partido actualizados exitosamente.");
    } catch (err) {
      console.error("Error updating match teams:", err);
      alert("Error al actualizar los equipos del partido.");
    } finally {
      setSavingTeams(false);
    }
  };

  const syncApiMatches = async () => {
    if (adminSyncing) return;
    const confirmSync = window.confirm("¿Deseas sincronizar los marcadores y estados en vivo desde la API oficial en este momento? Esto actualizará partidos iniciados/finalizados y recalculará los puntos.");
    if (!confirmSync) return;

    setAdminSyncing(true);
    try {
      const apiUrl = "https://worldcup26.ir/get/games";
      const apiResponse = await fetch(apiUrl);
      if (!apiResponse.ok) {
        throw new Error(`Error de la API: ${apiResponse.status}`);
      }

      const apiData = await apiResponse.json();
      const apiFixtures = apiData.games || [];

      // Mapeo canónico
      const mapApiTeamToDbTeam = (apiTeam: string) => {
        if (!apiTeam) return "";
        const clean = apiTeam.trim();
        if (clean === "United States") return "USA";
        if (clean === "Democratic Republic of the Congo") return "DR Congo";
        if (clean === "Bosnia and Herzegovina") return "Bosnia & Herzegovina";
        return clean;
      };

      const cleanNameLocal = (name: string) => {
        if (!name) return "";
        let clean = name.toLowerCase().trim();
        if (clean === "usa" || clean === "united states") return "unitedstates";
        if (clean === "dr congo" || clean === "democratic republic of the congo") return "democraticrepublicofthecongo";
        clean = clean.replace(/&/g, "and");
        return clean.replace(/[^a-z0-9]/g, "");
      };

      // Obtener partidos actuales
      const matchesSnap = await getDocs(collection(db, "matches"));
      const dbMatches: Match[] = [];
      matchesSnap.forEach(doc => {
        dbMatches.push({ ...doc.data() as Match, id: doc.id });
      });

      let updatedMatchesCount = 0;
      const batch = writeBatch(db);
      // Track which matches became final in this sync (for the incremental fast
      // path) and whether any already-final result was edited (forces fallback).
      const newlyFinalIds: string[] = [];
      let hasFinalEdit = false;

      for (const dbMatch of dbMatches) {
        const dbMatchIdNum = parseInt(dbMatch.id, 10);
        let fixture = null;
        const wasFinalBefore = !!(dbMatch.result && dbMatch.result.isFinal !== false);

        if (dbMatchIdNum >= 73) {
          fixture = apiFixtures.find((f: any) => parseInt(f.id, 10) === dbMatchIdNum);
        } else {
          fixture = apiFixtures.find((f: any) => {
            const apiHome = f.home_team_name_en;
            const apiAway = f.away_team_name_en;
            return (
              (cleanNameLocal(apiHome) === cleanNameLocal(dbMatch.team1) && cleanNameLocal(apiAway) === cleanNameLocal(dbMatch.team2)) ||
              (cleanNameLocal(apiHome) === cleanNameLocal(dbMatch.team2) && cleanNameLocal(apiAway) === cleanNameLocal(dbMatch.team1))
            );
          });
        }

        if (!fixture) continue;

        let teamNamesChanged = false;
        let updatedTeam1 = dbMatch.team1;
        let updatedTeam2 = dbMatch.team2;

        if (dbMatchIdNum >= 73 && fixture.home_team_name_en && fixture.away_team_name_en) {
          const mappedHome = mapApiTeamToDbTeam(fixture.home_team_name_en);
          const mappedAway = mapApiTeamToDbTeam(fixture.away_team_name_en);

          if (mappedHome !== dbMatch.team1 || mappedAway !== dbMatch.team2) {
            updatedTeam1 = mappedHome;
            updatedTeam2 = mappedAway;
            teamNamesChanged = true;
          }
        }

        const isFinished = fixture.finished === "TRUE";
        const isStarted = fixture.time_elapsed !== "notstarted";
        const kickoffPassed = Date.now() >= getMatchStartDate(dbMatch).getTime();

        let resultChanged = false;
        let newResult = dbMatch.result;

        // Ignore premature "live" scores from the API until kickoff time has passed.
        if (isFinished || (isStarted && kickoffPassed)) {
          const goalsHome = parseInt(fixture.home_score, 10);
          const goalsAway = parseInt(fixture.away_score, 10);

          if (!isNaN(goalsHome) && !isNaN(goalsAway)) {
            let realGoals1 = goalsHome;
            let realGoals2 = goalsAway;

            const checkHome = fixture.home_team_name_en || fixture.home_team_label;
            if (checkHome && cleanNameLocal(checkHome) === cleanNameLocal(dbMatch.team2)) {
              realGoals1 = goalsAway;
              realGoals2 = goalsHome;
            }

            newResult = { goals1: realGoals1, goals2: realGoals2, isFinal: isFinished };

            const currentResult = dbMatch.result;
            resultChanged = !currentResult ||
              currentResult.goals1 !== newResult.goals1 ||
              currentResult.goals2 !== newResult.goals2 ||
              currentResult.isFinal !== newResult.isFinal;
          }
        }

        if (resultChanged || teamNamesChanged) {
          const updateData: any = {};
          if (resultChanged) {
            updateData.result = newResult;
          }
          if (teamNamesChanged) {
            updateData.team1 = updatedTeam1;
            updateData.team2 = updatedTeam2;
          }
          batch.update(doc(db, "matches", dbMatch.id), updateData);
          updatedMatchesCount++;

          // Classify the result change for the persistence strategy below.
          if (resultChanged && newResult && newResult.isFinal) {
            if (wasFinalBefore) hasFinalEdit = true; // score correction on a final match
            else newlyFinalIds.push(dbMatch.id); // fresh finalization
          }

          // Actualizar temporalmente para el cálculo de abajo
          dbMatch.result = newResult;
          dbMatch.team1 = updatedTeam1;
          dbMatch.team2 = updatedTeam2;
        }
      }

      if (updatedMatchesCount > 0) {
        // Commit match/team updates first, then update the cumulative chain.
        // dbMatches already carries the updated results (mutated above).
        await batch.commit();

        // Fast path when matches were finalized at the end of the chain (and no
        // already-final result was edited); otherwise full recompute.
        let handled = false;
        if (!hasFinalEdit) {
          handled = await tryIncrementalFinalize(dbMatches, newlyFinalIds);
        }
        if (!handled) {
          await persistCumulativeScores(dbMatches);
        }

        // Bump matches_version so clients invalidate their active cache on next load
        await setDoc(doc(db, "meta", "matches_version"), { updatedAt: Date.now() }, { merge: true });
        alert(`Sincronización exitosa. Se actualizaron ${updatedMatchesCount} partidos y se recalcularon todos los puntajes.`);
      } else {
        await batch.commit();
        alert("Sincronización completada. No hubo cambios en los marcadores ni equipos.");
      }
    } catch (err: any) {
      console.error("Error syncing API matches:", err);
      alert(`Error al sincronizar: ${err?.message || err}`);
    } finally {
      setAdminSyncing(false);
    }
  };

  const handleCreateGroup = async () => {
    if (!newGroupName.trim() || !newGroupCode.trim()) {
      alert("Por favor ingresa el nombre y código del grupo.");
      return;
    }
    if (groups.some(g => g.code === newGroupCode)) {
      alert("El código de grupo ya está en uso.");
      return;
    }
    try {
      const newGroupRef = doc(collection(db, "groups"));
      const newGroup: Group = {
        id: newGroupRef.id,
        name: newGroupName.trim(),
        code: newGroupCode.trim(),
        createdAt: new Date(),
        createdBy: user?.uid || "admin",
        admins: user?.uid ? [user.uid] : ["admin"]
      };
      await setDoc(newGroupRef, newGroup);
      setNewGroupName("");
      setNewGroupCode("");
      alert("Grupo creado exitosamente.");
    } catch (err) {
      console.error("Error creating group:", err);
      alert("Error al crear el grupo.");
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    const isUserGroupAdmin = profile?.isAdmin || (user && group.admins?.includes(user.uid));
    if (!isUserGroupAdmin) {
      alert("No tienes permisos para eliminar este grupo.");
      return;
    }

    if (!window.confirm("¿Estás seguro de eliminar este grupo? Los usuarios no serán eliminados pero ya no pertenecerán a este grupo.")) return;
    try {
      await deleteDoc(doc(db, "groups", groupId));
      const usersToUpdate = leaderboard.filter(u => u.groupIds?.includes(groupId));
      const batch = writeBatch(db);
      usersToUpdate.forEach(u => {
        if (u.uid && u.uid !== "undefined") {
          const newGroupIds = u.groupIds?.filter(id => id !== groupId) || [];
          batch.set(doc(db, "users", u.uid), { groupIds: newGroupIds }, { merge: true });
        }
      });
      await batch.commit();
      if (adminSelectedGroupId === groupId) {
        setAdminSelectedGroupId("");
      }
      alert("Grupo eliminado exitosamente.");
    } catch (err) {
      console.error("Error deleting group:", err);
      alert("Error al eliminar el grupo.");
    }
  };

  const handleAddUserToGroup = async (userId: string, groupId: string) => {
    try {
      const userProf = leaderboard.find(u => u.uid === userId);
      if (!userProf) return;
      const currentGroups = userProf.groupIds || [];
      if (!currentGroups.includes(groupId)) {
        const updatedGroups = [...currentGroups, groupId];
        await setDoc(doc(db, "users", userId), { groupIds: updatedGroups }, { merge: true });
        alert("Jugador agregado al grupo.");
      }
    } catch (err) {
      console.error("Error adding user to group:", err);
      alert("Error al agregar jugador al grupo.");
    }
  };

  const handleRemoveUserFromGroup = async (userId: string, groupId: string) => {
    if (!window.confirm("¿Estás seguro de quitar a este jugador del grupo?")) return;
    try {
      const userProf = leaderboard.find(u => u.uid === userId);
      if (!userProf) return;
      const currentGroups = userProf.groupIds || [];
      const updatedGroups = currentGroups.filter(id => id !== groupId);
      await setDoc(doc(db, "users", userId), { groupIds: updatedGroups }, { merge: true });
      alert("Jugador removido del grupo.");
    } catch (err) {
      console.error("Error removing user from group:", err);
      alert("Error al remover jugador del grupo.");
    }
  };

  const handlePromoteToGroupAdmin = async (userId: string, groupId: string) => {
    try {
      const activeGroup = groups.find((g) => g.id === groupId);
      if (!activeGroup) return;
      const currentAdmins = activeGroup.admins || [];
      if (!currentAdmins.includes(userId)) {
        const updatedAdmins = [...currentAdmins, userId];
        await setDoc(doc(db, "groups", groupId), { admins: updatedAdmins }, { merge: true });
        alert("Usuario promovido a administrador del grupo.");
      }
    } catch (err) {
      console.error("Error promoting to group admin:", err);
      alert("Error al promover a administrador del grupo.");
    }
  };

  const handleDemoteFromGroupAdmin = async (userId: string, groupId: string) => {
    try {
      const activeGroup = groups.find((g) => g.id === groupId);
      if (!activeGroup) return;
      const currentAdmins = activeGroup.admins || [];
      if (currentAdmins.includes(userId)) {
        if (currentAdmins.length === 1) {
          alert("Debe haber al menos un administrador en el grupo.");
          return;
        }
        const updatedAdmins = currentAdmins.filter(id => id !== userId);
        await setDoc(doc(db, "groups", groupId), { admins: updatedAdmins }, { merge: true });
        alert("Usuario removido de los administradores del grupo.");
      }
    } catch (err) {
      console.error("Error demoting from group admin:", err);
      alert("Error al remover de los administradores del grupo.");
    }
  };
  const handleForceDeleteUser = async (userId: string) => {
    if (!profile?.isAdmin) return;
    const targetUser = leaderboard.find(u => u.uid === userId);
    if (!targetUser) return;

    if (!window.confirm(`¿Estás absolutamente seguro de eliminar al usuario "${targetUser.displayName}" (${targetUser.email})? Se borrarán sus puntos y todas sus predicciones permanentemente. (El usuario no podrá ingresar ni figurar en la polla).`)) return;

    try {
      const batch = writeBatch(db);
      // Delete user document in users collection
      batch.delete(doc(db, "users", userId));

      // Fetch and delete predictions of this user
      const predsSnap = await getDocs(collection(db, "predictions"));
      predsSnap.forEach((doc) => {
        if (doc.data().userId === userId) {
          batch.delete(doc.ref);
        }
      });

      await batch.commit();
      alert(`Usuario "${targetUser.displayName}" eliminado exitosamente.`);
    } catch (err) {
      console.error("Error deleting user:", err);
      alert("Error al eliminar el usuario.");
    }
  };

  const handleEditUserDisplayName = async (userId: string) => {
    if (!profile?.isAdmin) return;
    const targetUser = leaderboard.find(u => u.uid === userId);
    if (!targetUser) return;

    const newName = window.prompt(`Ingresa el nuevo nombre para el usuario "${targetUser.displayName}":`, targetUser.displayName);
    if (newName === null) return; // User cancelled
    const cleanName = newName.trim();
    if (!cleanName) {
      alert("El nombre no puede estar vacío.");
      return;
    }

    try {
      await setDoc(doc(db, "users", userId), { displayName: cleanName }, { merge: true });
      alert(`Nombre del usuario actualizado a "${cleanName}" exitosamente.`);
    } catch (err) {
      console.error("Error updating display name:", err);
      alert("Error al actualizar el nombre del usuario.");
    }
  };

  // Filtered leaderboard based on selected group
  const displayedLeaderboard = React.useMemo(() => {
    if (selectedGroupId === "global") {
      return leaderboard;
    }
    return leaderboard.filter((u) => u.groupIds?.includes(selectedGroupId));
  }, [leaderboard, selectedGroupId]);

  // Unique list of rounds for filtering
  const rounds = ["Todos", "Matchday 1", "Matchday 2", "Matchday 3", "Matchday 4", "Matchday 5", "Matchday 6", "Matchday 7", "Matchday 8", "Matchday 9", "Matchday 10", "Matchday 11", "Matchday 12", "Matchday 13", "Matchday 14", "Matchday 15", "Matchday 16", "Matchday 17", "Round of 32", "Round of 16", "Quarter-final", "Semi-final", "Match for third place", "Final"];

  // Sort matches chronologically
  const sortedMatches = React.useMemo(() => {
    return [...matches].sort((a, b) => {
      const dateA = getMatchStartDate(a).getTime();
      const dateB = getMatchStartDate(b).getTime();
      if (dateA !== dateB) {
        return dateA - dateB;
      }
      return a.num - b.num;
    });
  }, [matches]);

  const filteredMatches = selectedRound === "Todos"
    ? sortedMatches
    : sortedMatches.filter(m => m.round === selectedRound);

  const pastMatchesCount = React.useMemo(() => {
    return filteredMatches.filter(isArchivedMatch).length;
  }, [filteredMatches]);

  const combinedUserGroupedMatches = React.useMemo(() => {
    // 1. Group active matches (oldest to newest)
    const activeSorted = [...filteredMatches.filter(m => !isArchivedMatch(m))].sort((a, b) => {
      const dateA = getMatchStartDate(a).getTime();
      const dateB = getMatchStartDate(b).getTime();
      if (dateA !== dateB) {
        return dateA - dateB;
      }
      return a.num - b.num;
    });

    const activeGroups: { [key: string]: Match[] } = {};
    const activeOrder: string[] = [];

    activeSorted.forEach((match) => {
      const matchDate = getMatchStartDate(match);
      const label = capitalizeFirstLetter(
        matchDate.toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric"
        })
      );
      if (!activeGroups[label]) {
        activeGroups[label] = [];
        activeOrder.push(label);
      }
      activeGroups[label].push(match);
    });

    const activeGroups_result = activeOrder.map(label => ({
      dateLabel: label,
      isArchived: false,
      matches: activeGroups[label]
    }));

    // 2. Group archived matches (newest to oldest, matches inside also newest first)
    if (!hidePastMatches) {
      const archivedSorted = [...filteredMatches.filter(m => isArchivedMatch(m))].sort((a, b) => {
        const dateA = getMatchStartDate(a).getTime();
        const dateB = getMatchStartDate(b).getTime();
        if (dateA !== dateB) {
          return dateB - dateA; // Newest date first
        }
        return b.num - a.num; // Newest match first
      });

      const archivedGroups: { [key: string]: Match[] } = {};
      const archivedOrder: string[] = [];

      archivedSorted.forEach((match) => {
        const matchDate = getMatchStartDate(match);
        const label = capitalizeFirstLetter(
          matchDate.toLocaleDateString(undefined, {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric"
          })
        );
        if (!archivedGroups[label]) {
          archivedGroups[label] = [];
          archivedOrder.push(label);
        }
        archivedGroups[label].push(match);
      });

      // Archived groups go FIRST so they appear at the top without scrolling
      const archivedResult = archivedOrder.map(label => ({
        dateLabel: label,
        isArchived: true,
        matches: archivedGroups[label]
      }));

      return [...archivedResult, ...activeGroups_result];
    }

    return activeGroups_result;
  }, [filteredMatches, hidePastMatches]);

  const adminFilteredMatches = React.useMemo(() => {
    if (hidePastMatchesAdmin) {
      return filteredMatches.filter(m => !isArchivedMatch(m));
    }
    return filteredMatches;
  }, [filteredMatches, hidePastMatchesAdmin]);

  const groupedMatches = React.useMemo(() => {
    const sorted = [...adminFilteredMatches].sort((a, b) => {
      const dateA = getMatchStartDate(a).getTime();
      const dateB = getMatchStartDate(b).getTime();
      if (dateA !== dateB) {
        return dateA - dateB;
      }
      return a.num - b.num;
    });

    const groups: { [key: string]: Match[] } = {};
    const groupOrder: string[] = [];

    sorted.forEach((match) => {
      const matchDate = getMatchStartDate(match);
      const label = capitalizeFirstLetter(
        matchDate.toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric"
        })
      );
      if (!groups[label]) {
        groups[label] = [];
        groupOrder.push(label);
      }
      groups[label].push(match);
    });

    return groupOrder.map(label => ({
      dateLabel: label,
      matches: groups[label]
    }));
  }, [adminFilteredMatches]);

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-950 text-white p-6">
        <div className="w-16 h-16 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="mt-4 text-slate-400 font-medium animate-pulse">Cargando polla mundialista...</p>
      </div>
    );
  }

  // Not logged in: Show auth screen
  if (!user) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black">
        <div className="w-full max-w-md bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 rounded-2xl shadow-2xl p-8 transition-all duration-300">
          <div className="text-center mb-8">
            <span className="text-5xl mb-2 block animate-bounce">🏆</span>
            <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-emerald-400 via-teal-300 to-amber-300 bg-clip-text text-transparent">
              Polla Mundial 2026
            </h1>
            {/* <p className="text-emerald-450 font-extrabold text-xs tracking-wider mt-1.5 uppercase text-emerald-400">
              Amigos
            </p> */}
            <p className="text-slate-400 text-sm mt-2">
              {isRegistering ? "Regístrate para pronosticar los 104 partidos" : "Inicia sesión para ver tu puntaje y pronósticos"}
            </p>
          </div>

          {inviteGroup && (
            <div className="mb-6 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-center text-xs text-emerald-450">
              👋 Te han invitado a unirte al grupo: <strong>{inviteGroup.name}</strong>.
              <br />
              <span className="text-slate-400 mt-1 block">Regístrate o inicia sesión abajo para unirte.</span>
            </div>
          )}

          {savedAccounts.length > 0 && !isRegistering && (
            <div className="mb-6 border-b border-slate-800/60 pb-5">
              <span className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2.5">
                Ingresar con cuenta guardada:
              </span>
              <div className="space-y-2">
                {savedAccounts.map((acc) => (
                  <div
                    key={acc.email}
                    className="flex items-center justify-between p-2.5 bg-slate-950/40 hover:bg-slate-950/80 border border-slate-850 rounded-xl transition-all group"
                  >
                    <button
                      type="button"
                      onClick={async () => {
                        setAuthError("");
                        setAuthLoading(true);
                        try {
                          await switchAccount(acc.email);
                        } catch (err: any) {
                          setAuthError("No se pudo iniciar sesión de forma automática.");
                        } finally {
                          setAuthLoading(false);
                        }
                      }}
                      className="flex-1 text-left flex flex-col"
                    >
                      <span className="font-bold text-xs text-slate-200 group-hover:text-emerald-400 transition-colors">
                        {acc.name}
                      </span>
                      <span className="text-[10px] text-slate-400 truncate max-w-[200px]">
                        {acc.email}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeSavedAccount(acc.email)}
                      className="text-slate-500 hover:text-rose-400 text-xs p-1 transition-colors"
                      title="Eliminar"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <form onSubmit={handleAuthSubmit} className="space-y-4">
            {isRegistering && (
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">Nombre Completo</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ej. Cristiano Ronaldo"
                  required
                  className="w-full px-4 py-3 bg-slate-950/50 border border-slate-800 rounded-xl focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 text-slate-100 transition-colors"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">Correo Electrónico</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="usuario@correo.com"
                required
                className="w-full px-4 py-3 bg-slate-950/50 border border-slate-800 rounded-xl focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 text-slate-100 transition-colors"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">Contraseña</label>
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="******"
                required
                className="w-full px-4 py-3 bg-slate-950/50 border border-slate-800 rounded-xl focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 text-slate-100 transition-colors"
              />
            </div>
            {!isRegistering && (
              <button
                type="button"
                onClick={handleForgotPassword}
                className="text-emerald-400 hover:text-emerald-300 text-xs font-semibold focus:outline-none cursor-pointer"
              >
                ¿Olvidaste tu contraseña?
              </button>
            )}
            {authError && (
              <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm px-4 py-3 rounded-xl">
                ⚠️ {authError}
              </div>
            )}

            <button
              type="submit"
              disabled={authLoading}
              className="w-full py-3 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-slate-950 font-bold rounded-xl shadow-lg hover:shadow-emerald-500/20 active:scale-[0.98] transition-all duration-200 flex items-center justify-center disabled:opacity-50"
            >
              {authLoading ? (
                <div className="w-5 h-5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></div>
              ) : isRegistering ? (
                "Crear Cuenta"
              ) : (
                "Ingresar"
              )}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={() => {
                setIsRegistering(!isRegistering);
                setAuthError("");
              }}
              className="text-emerald-400 hover:text-emerald-300 text-sm font-medium transition-colors"
            >
              {isRegistering ? "¿Ya tienes cuenta? Inicia Sesión" : "¿No tienes cuenta? Regístrate aquí"}
            </button>
          </div>
        </div>

        {/* Toast Notification */}
        {toast && (
          <div className="fixed bottom-5 right-5 z-[9999] animate-in fade-in slide-in-from-bottom-5 duration-300">
            <div className={`px-4 py-3 rounded-2xl border backdrop-blur-xl shadow-2xl flex items-center gap-2.5 text-xs font-bold ${toast.type === "success" ? "bg-emerald-950/80 text-emerald-400 border-emerald-500/20" :
              toast.type === "error" ? "bg-rose-950/80 text-rose-400 border-rose-500/20" :
                "bg-slate-900/80 text-slate-350 border-slate-800"
              }`}>
              <span className="text-sm">{toast.type === "success" ? "🏆" : toast.type === "error" ? "❌" : "ℹ️"}</span>
              <span>{toast.message}</span>
              <button
                type="button"
                onClick={() => setToast(null)}
                className="ml-2 text-slate-400 hover:text-white transition-colors font-extrabold"
              >
                ✕
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Logged in user dashboard
  return (
    <div className="flex-1 flex flex-col bg-slate-950 min-h-screen overflow-x-hidden">
      {/* Header */}
      <header className="bg-slate-900/40 backdrop-blur-md border-b border-slate-900 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="text-2xl">🏆</span>
            <div className="hidden sm:flex flex-col">
              <span className="font-extrabold text-base sm:text-lg bg-gradient-to-r from-emerald-400 to-amber-300 bg-clip-text text-transparent leading-none">
                Polla Mundial 2026
              </span>
              <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider mt-0.5 leading-none">
                Amigos
              </span>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            <div className="hidden sm:flex flex-col text-right">
              <span className="text-xs text-slate-400 font-bold uppercase tracking-wider">Jugador</span>
              <div className="flex items-center justify-end space-x-1.5">
                <span className="font-semibold text-slate-200">{profile?.displayName}</span>
                <button
                  onClick={() => {
                    if (profile) {
                      setNewDisplayName(profile.displayName || "");
                      setIsManualEditName(true);
                      setShowNameRestoreModal(true);
                    }
                  }}
                  title="Editar mi nombre"
                  className="text-[10px] text-slate-500 hover:text-emerald-400 transition-colors focus:outline-none"
                >
                  ✏️
                </button>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-full px-4 py-1.5 flex items-center space-x-1.5">
                <span className="text-amber-400 font-bold">⭐</span>
                <span className="font-extrabold text-emerald-400 text-sm">{profile?.points ?? 0} Pts</span>
              </div>
            </div>

            {savedAccounts.filter(acc => acc.email !== user?.email).length > 0 && (
              <select
                onChange={async (e) => {
                  if (e.target.value) {
                    try {
                      await switchAccount(e.target.value);
                    } catch (err) {
                      alert("Error al cambiar de cuenta");
                    }
                  }
                  e.target.value = "";
                }}
                className="px-2.5 py-1.5 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-semibold rounded-lg border border-slate-750 focus:outline-none cursor-pointer"
                defaultValue=""
              >
                <option value="" disabled>Cambiar Cuenta</option>
                {savedAccounts.filter(acc => acc.email !== user?.email).map(acc => (
                  <option key={acc.email} value={acc.email}>
                    {acc.name}
                  </option>
                ))}
              </select>
            )}

            <button
              onClick={logout}
              className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 hover:text-rose-400 text-slate-300 text-xs font-semibold rounded-lg border border-slate-700 transition-all active:scale-[0.97]"
            >
              Salir
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col lg:flex-row gap-6">

        {/* Navigation Sidebar / Tabs */}
        <section className="w-full lg:w-64 flex flex-row lg:flex-col gap-2 pb-2 lg:pb-0 shrink-0 lg:h-fit">
          <button
            onClick={() => setActiveTab("matches")}
            className={`flex-1 lg:flex-none lg:w-full px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl font-bold text-xs sm:text-sm whitespace-nowrap text-center lg:text-left flex items-center justify-center lg:justify-start space-x-2 transition-all shrink-0 ${activeTab === "matches"
              ? "bg-gradient-to-r from-emerald-500/20 to-teal-500/10 border-b-2 lg:border-b-0 lg:border-l-4 border-emerald-500 text-emerald-400"
              : "bg-slate-900/40 hover:bg-slate-900/80 text-slate-400 hover:text-slate-200 border-b-2 border-transparent lg:border-b-0"
              }`}
          >
            <span>📅</span>
            <span>Pronósticos</span>
          </button>

          <button
            onClick={() => setActiveTab("leaderboard")}
            className={`flex-1 lg:flex-none lg:w-full px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl font-bold text-xs sm:text-sm whitespace-nowrap text-center lg:text-left flex items-center justify-center lg:justify-start space-x-2 transition-all shrink-0 ${activeTab === "leaderboard"
              ? "bg-gradient-to-r from-emerald-500/20 to-teal-500/10 border-b-2 lg:border-b-0 lg:border-l-4 border-emerald-500 text-emerald-400"
              : "bg-slate-900/40 hover:bg-slate-900/80 text-slate-400 hover:text-slate-200 border-b-2 border-transparent lg:border-b-0"
              }`}
          >
            <span>🏆</span>
            <span>Posiciones</span>
          </button>

          {user && (
            <button
              onClick={() => {
                setActiveTab("admin");
                if (!profile?.isAdmin) {
                  setAdminSubTab("groups");
                }
              }}
              className={`flex-1 lg:flex-none lg:w-full px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl font-bold text-xs sm:text-sm whitespace-nowrap text-center lg:text-left flex items-center justify-center lg:justify-start space-x-2 transition-all shrink-0 ${activeTab === "admin"
                ? "bg-gradient-to-r from-amber-500/20 to-yellow-500/10 border-b-2 lg:border-b-0 lg:border-l-4 border-amber-500 text-amber-400"
                : "bg-slate-900/40 hover:bg-slate-900/80 text-slate-400 hover:text-slate-200 border-b-2 border-transparent lg:border-b-0"
                }`}
            >
              <span>👥</span>
              <span>Grupos / Admin</span>
            </button>
          )}
        </section>

        {/* Content Area */}
        <section className="flex-1">
          {dataLoading ? (
            <div className="h-64 flex flex-col items-center justify-center bg-slate-900/20 rounded-2xl border border-slate-900">
              <div className="w-10 h-10 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
              <p className="mt-3 text-slate-500 text-sm animate-pulse">Obteniendo datos de Firebase...</p>
            </div>
          ) : (
            <>
              {/* TAB: PRONÓSTICOS */}
              {activeTab === "matches" && (
                <div className="space-y-6">
                  {/* Round Filter */}
                  <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-3.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                    <div>
                      <h2 className="text-base font-extrabold text-slate-200">Calendario Oficial</h2>
                      <p className="text-slate-400 text-[11px]">Completa tus predicciones del Mundial</p>
                    </div>

                    <div className="flex items-center gap-2 w-full sm:w-auto justify-start sm:justify-end">
                      {pastMatchesCount > 0 && (
                        <button
                          onClick={() => setHidePastMatches(!hidePastMatches)}
                          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all border flex items-center gap-1 shrink-0 ${hidePastMatches
                            ? "bg-emerald-950/30 text-emerald-400 border-emerald-900/40 hover:bg-emerald-900/20"
                            : "bg-slate-900/60 text-slate-300 border-slate-800 hover:bg-slate-800"
                            }`}
                        >
                          {hidePastMatches ? (
                            <>
                              <span className="mr-1">👁️</span> {pastMatchesCount} pasados
                            </>
                          ) : (
                            <>
                              <span>🙈</span> Ocultar
                            </>
                          )}
                        </button>
                      )}

                      <select
                        value={selectedRound}
                        onChange={(e) => setSelectedRound(e.target.value)}
                        className="px-3 py-1.5 bg-slate-950 border border-slate-800 text-slate-300 text-xs rounded-xl focus:outline-none focus:border-emerald-500 w-full sm:w-auto"
                      >
                        {rounds.map((round) => (
                          <option key={round} value={round}>{formatRoundName(round)}</option>
                        ))}
                      </select>

                      <button
                        onClick={forceSyncMatches}
                        disabled={matchesSyncing || syncCooldown > 0}
                        className="px-3 py-1.5 rounded-xl text-xs font-bold transition-all border border-slate-800 bg-slate-900/60 hover:bg-slate-850 text-slate-350 disabled:opacity-50 flex items-center gap-1.5 shrink-0"
                        title={syncCooldown > 0 ? `Por favor espera ${syncCooldown}s` : (lastMatchesUpdate ? `Última sincronización: ${new Date(lastMatchesUpdate).toLocaleTimeString()}` : "Forzar sincronización de partidos")}
                      >
                        {matchesSyncing ? (
                          <>
                            <span className="inline-block w-3 h-3 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></span>
                            Sincronizando...
                          </>
                        ) : syncCooldown > 0 ? (
                          <>
                            <span>⏳</span>
                            Esperar {syncCooldown}s
                          </>
                        ) : (
                          <>
                            <span>🔄</span>
                            Sincronizar
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Matches Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {combinedUserGroupedMatches.length === 0 ? (
                      <div className="col-span-full py-12 text-center text-slate-500 bg-slate-900/10 border border-slate-900/40 rounded-2xl p-6">
                        {pastMatchesCount > 0 && hidePastMatches ? (
                          <>
                            <p className="text-slate-400 text-sm mb-3">Todos los partidos de esta ronda ya comenzaron o finalizaron.</p>
                            <button
                              onClick={() => setHidePastMatches(false)}
                              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-xs font-extrabold rounded-xl transition-colors shadow-lg shadow-emerald-500/20"
                            >
                              Ver partidos finalizados
                            </button>
                          </>
                        ) : (
                          "No se encontraron partidos para esta ronda."
                        )}
                      </div>
                    ) : (
                      combinedUserGroupedMatches.map((group, index) => {
                        // Show archived section header at the very first archived group
                        const showArchivedHeader = group.isArchived && (index === 0 || !combinedUserGroupedMatches[index - 1].isArchived);
                        // Show upcoming section header at the first active group after archived groups
                        const showUpcomingHeader = !group.isArchived && index > 0 && combinedUserGroupedMatches[index - 1].isArchived;
                        return (
                          <React.Fragment key={`${group.dateLabel}-${group.isArchived ? "archived" : "active"}`}>
                            {showArchivedHeader && (
                              <div className="col-span-full mb-4 flex items-center space-x-3">
                                <h3 className="text-xs font-extrabold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                                  <span>📚</span> Historial de Partidos Finalizados
                                </h3>
                                <div className="h-px bg-slate-800/60 flex-1"></div>
                              </div>
                            )}
                            {showUpcomingHeader && (
                              <div className="col-span-full mt-10 mb-4 flex items-center space-x-3">
                                <h3 className="text-xs font-extrabold text-emerald-500/70 uppercase tracking-wider flex items-center gap-1.5">
                                  <span>📅</span> Próximos Partidos
                                </h3>
                                <div className="h-px bg-slate-800/60 flex-1"></div>
                              </div>
                            )}
                            {/* Day Header */}
                            <div className="col-span-full mt-6 first:mt-0 mb-2">
                              <div className="flex items-center space-x-3">
                                <span className={`text-[11px] font-extrabold uppercase tracking-wider bg-slate-900/80 px-3 py-1.5 rounded-xl border shadow-sm ${group.isArchived ? "text-slate-400 border-slate-900" : "text-emerald-400 border-slate-800/80"}`}>
                                  {group.dateLabel}
                                </span>
                                <div className="h-px bg-slate-900 flex-1"></div>
                              </div>
                            </div>

                            {/* Group Matches */}
                            {group.matches.map((match) => {
                              const pred = predictions[match.id];
                              const draft = predictionDrafts[match.id] || { goals1: "", goals2: "" };
                              const isSaving = savingMatches[match.id];
                              const hasResult = match.result != null;
                              const isFinal = match.result != null && match.result.isFinal !== false;
                              const isLive = isMatchLive(match);
                              const isLocked = hasMatchStarted(match);

                              const matchDate = getMatchStartDate(match);
                              const localTimeStr = matchDate.toLocaleTimeString(undefined, {
                                hour: '2-digit',
                                minute: '2-digit',
                                hour12: false
                              });
                              const tzAbbr = getTzAbbreviation();

                              return (
                                <div
                                  key={match.id}
                                  className={`bg-slate-900/40 hover:bg-slate-900/60 transition-all border border-slate-900/80 hover:border-slate-800 rounded-2xl p-5 flex flex-col justify-between ${group.isArchived ? "opacity-80 border-slate-950/60" : ""}`}
                                >
                                  {/* Match Header */}
                                  <div className="flex justify-between items-center text-xs text-slate-400 border-b border-slate-950/60 pb-3 mb-4 relative">
                                    <span className="font-bold text-emerald-500 flex items-center gap-1.5 flex-wrap">
                                      <span>{formatRoundName(match.round)} {match.group ? `• ${match.group}` : ""}</span>
                                      {!match.group && (
                                        <span className="text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/20 px-1.5 py-0.5 rounded font-extrabold uppercase tracking-wider">
                                          x2 Puntos
                                        </span>
                                      )}
                                    </span>
                                    {isLive && (
                                      <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5">
                                        <span className="text-[10px] sm:text-xs bg-amber-500/15 border border-amber-500/30 text-amber-500 px-2.5 py-1 rounded-lg font-extrabold flex items-center gap-1.5 animate-pulse">
                                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span>
                                          ⚡ En Juego
                                        </span>
                                        {/* <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          forceSyncMatches();
                                        }}
                                        disabled={matchesSyncing || syncCooldown > 0}
                                        className="w-6 h-6 rounded-lg bg-slate-950 border border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-850 flex items-center justify-center transition-all disabled:opacity-40 shrink-0 shadow-sm"
                                        title={syncCooldown > 0 ? `Por favor espera ${syncCooldown}s` : "Actualizar marcador"}
                                      >
                                        {matchesSyncing ? (
                                          <span className="w-2.5 h-2.5 border border-slate-400 border-t-transparent rounded-full animate-spin"></span>
                                        ) : (
                                          <span className="text-[10px]">🔄</span>
                                        )}
                                      </button> */}
                                      </div>
                                    )}
                                    <span className="font-semibold text-slate-300">{localTimeStr} {tzAbbr}</span>
                                  </div>

                                  {/* Teams and Inputs */}
                                  <div className="flex items-center justify-between gap-3 my-4">
                                    {/* Team 1 */}
                                    {getFlagUrl(match.team1) ? (
                                      <button
                                        type="button"
                                        onClick={() => setSelectedTeamHistory(match.team1)}
                                        title={`Ver historial de partidos de ${match.team1}`}
                                        className="flex-1 flex flex-col items-center justify-center space-y-1.5 min-w-0 group cursor-pointer select-none hover:scale-105 active:scale-95 transition-all p-1 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500/20"
                                      >
                                        <img
                                          src={getFlagUrl(match.team1)!}
                                          alt={match.team1}
                                          className="w-8 h-5.5 object-cover rounded-sm shadow-md border border-slate-900 shrink-0 group-hover:shadow-emerald-500/10 transition-shadow"
                                        />
                                        <span className="font-bold text-xs sm:text-sm text-slate-200 text-center w-full break-words group-hover:text-emerald-400 transition-colors">
                                          {match.team1}
                                        </span>
                                      </button>
                                    ) : (
                                      <div className="flex-1 flex flex-col items-center justify-center space-y-1.5 min-w-0">
                                        <span className="font-bold text-xs sm:text-sm text-slate-400 text-center w-full break-words">
                                          {match.team1}
                                        </span>
                                      </div>
                                    )}

                                    {/* Prediction / Score inputs */}
                                    <div className="flex items-center gap-2 shrink-0">
                                      <div className="flex flex-col sm:flex-row items-center gap-1">
                                        {!isLocked && (
                                          <button
                                            type="button"
                                            disabled={isLocked || isSaving}
                                            onClick={() => {
                                              const current = draft.goals1 === "" ? 0 : parseInt(draft.goals1, 10);
                                              const newVal = Math.max(0, isNaN(current) ? 0 : current - 1);
                                              setPredictionDrafts(prev => ({
                                                ...prev,
                                                [match.id]: { ...draft, goals1: String(newVal) }
                                              }));
                                            }}
                                            className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-emerald-500/40 hover:text-emerald-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 disabled:hover:bg-slate-900 disabled:hover:text-slate-400 select-none cursor-pointer order-3 sm:order-1"
                                          >
                                            -
                                          </button>
                                        )}
                                        <input
                                          type="text"
                                          inputMode="numeric"
                                          pattern="[0-9]*"
                                          value={draft.goals1}
                                          disabled={isLocked || isSaving}
                                          onChange={(e) => {
                                            const val = e.target.value.replace(/[^0-9]/g, "");
                                            setPredictionDrafts(prev => ({
                                              ...prev,
                                              [match.id]: { ...draft, goals1: val }
                                            }));
                                          }}
                                          className="w-9 h-9 text-center bg-slate-950 border border-slate-800 focus:border-emerald-500 text-sm font-extrabold rounded-lg focus:outline-none disabled:opacity-60 disabled:bg-slate-900/30 text-emerald-400 order-2"
                                          placeholder="-"
                                        />
                                        {!isLocked && (
                                          <button
                                            type="button"
                                            disabled={isLocked || isSaving}
                                            onClick={() => {
                                              const current = draft.goals1 === "" ? -1 : parseInt(draft.goals1, 10);
                                              const newVal = (isNaN(current) ? -1 : current) + 1;
                                              setPredictionDrafts(prev => ({
                                                ...prev,
                                                [match.id]: { ...draft, goals1: String(newVal) }
                                              }));
                                            }}
                                            className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-emerald-500/40 hover:text-emerald-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 disabled:hover:bg-slate-900 disabled:hover:text-slate-400 select-none cursor-pointer order-1 sm:order-3"
                                          >
                                            +
                                          </button>
                                        )}
                                      </div>
                                      <span className="text-slate-655 font-bold">vs</span>
                                      <div className="flex flex-col sm:flex-row items-center gap-1">
                                        {!isLocked && (
                                          <button
                                            type="button"
                                            disabled={isLocked || isSaving}
                                            onClick={() => {
                                              const current = draft.goals2 === "" ? 0 : parseInt(draft.goals2, 10);
                                              const newVal = Math.max(0, isNaN(current) ? 0 : current - 1);
                                              setPredictionDrafts(prev => ({
                                                ...prev,
                                                [match.id]: { ...draft, goals2: String(newVal) }
                                              }));
                                            }}
                                            className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-emerald-500/40 hover:text-emerald-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 disabled:hover:bg-slate-900 disabled:hover:text-slate-400 select-none cursor-pointer order-3 sm:order-1"
                                          >
                                            -
                                          </button>
                                        )}
                                        <input
                                          type="text"
                                          inputMode="numeric"
                                          pattern="[0-9]*"
                                          value={draft.goals2}
                                          disabled={isLocked || isSaving}
                                          onChange={(e) => {
                                            const val = e.target.value.replace(/[^0-9]/g, "");
                                            setPredictionDrafts(prev => ({
                                              ...prev,
                                              [match.id]: { ...draft, goals2: val }
                                            }));
                                          }}
                                          className="w-9 h-9 text-center bg-slate-950 border border-slate-800 focus:border-emerald-500 text-sm font-extrabold rounded-lg focus:outline-none disabled:opacity-60 disabled:bg-slate-900/30 text-emerald-400 order-2"
                                          placeholder="-"
                                        />
                                        {!isLocked && (
                                          <button
                                            type="button"
                                            disabled={isLocked || isSaving}
                                            onClick={() => {
                                              const current = draft.goals2 === "" ? -1 : parseInt(draft.goals2, 10);
                                              const newVal = (isNaN(current) ? -1 : current) + 1;
                                              setPredictionDrafts(prev => ({
                                                ...prev,
                                                [match.id]: { ...draft, goals2: String(newVal) }
                                              }));
                                            }}
                                            className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-emerald-500/40 hover:text-emerald-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 disabled:hover:bg-slate-900 disabled:hover:text-slate-400 select-none cursor-pointer order-1 sm:order-3"
                                          >
                                            +
                                          </button>
                                        )}
                                      </div>
                                    </div>

                                    {/* Team 2 */}
                                    {getFlagUrl(match.team2) ? (
                                      <button
                                        type="button"
                                        onClick={() => setSelectedTeamHistory(match.team2)}
                                        title={`Ver historial de partidos de ${match.team2}`}
                                        className="flex-1 flex flex-col items-center justify-center space-y-1.5 min-w-0 group cursor-pointer select-none hover:scale-105 active:scale-95 transition-all p-1 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500/20"
                                      >
                                        <img
                                          src={getFlagUrl(match.team2)!}
                                          alt={match.team2}
                                          className="w-8 h-5.5 object-cover rounded-sm shadow-md border border-slate-900 shrink-0 group-hover:shadow-emerald-500/10 transition-shadow"
                                        />
                                        <span className="font-bold text-xs sm:text-sm text-slate-200 text-center w-full break-words group-hover:text-emerald-400 transition-colors">
                                          {match.team2}
                                        </span>
                                      </button>
                                    ) : (
                                      <div className="flex-1 flex flex-col items-center justify-center space-y-1.5 min-w-0">
                                        <span className="font-bold text-xs sm:text-sm text-slate-400 text-center w-full break-words">
                                          {match.team2}
                                        </span>
                                      </div>
                                    )}
                                  </div>

                                  {/* Match Footer */}
                                  <div className="mt-4 pt-3 border-t border-slate-950/60 flex items-center justify-between">
                                    <span className="text-[10px] text-slate-500 truncate max-w-[150px]">
                                      {match.ground}
                                    </span>
                                    {(() => {
                                      const isFinal = match.result != null && match.result.isFinal !== false;
                                      const isLive = isMatchLive(match);

                                      if (isFinal) {
                                        return (
                                          <div className="flex items-center space-x-2">
                                            <span className="text-xs bg-slate-950 border border-slate-800 text-slate-400 px-2.5 py-1 rounded-lg">
                                              Final: {match.result?.goals1} - {match.result?.goals2}
                                            </span>
                                            {pred ? (
                                              <span className={`text-xs font-bold px-2 py-1 rounded-lg ${getPointsBadgeClass(pred?.points ?? 0)}`}>
                                                +{pred?.points ?? 0} Pts
                                              </span>
                                            ) : (
                                              <span className="text-xs font-bold px-2 py-1 rounded-lg bg-slate-950 border border-slate-850/80 text-rose-500">
                                                Sin pronóstico
                                              </span>
                                            )}
                                          </div>
                                        );
                                      }

                                      if (isLive) {
                                        const liveGoals1 = match.result ? match.result.goals1 : 0;
                                        const liveGoals2 = match.result ? match.result.goals2 : 0;
                                        const currentPoints = pred ? calculatePoints(pred.goals1, pred.goals2, liveGoals1, liveGoals2, match.group) : 0;

                                        return (
                                          <div className="flex items-center space-x-2">
                                            <div className="inline-flex items-center bg-slate-950 border border-slate-800 rounded-xl overflow-hidden whitespace-nowrap">
                                              <span className="text-xs text-slate-100 font-bold px-3 py-1.5">
                                                En Vivo: <span className="text-amber-400 font-extrabold">{liveGoals1} - {liveGoals2}</span>
                                              </span>
                                              <div className="w-px h-6 bg-slate-800"></div>
                                              <button
                                                onClick={() => refreshLiveMatchScore(match.id)}
                                                disabled={refreshingMatches[match.id]}
                                                title="Actualizar marcador"
                                                className="px-2.5 py-1.5 hover:bg-slate-900 text-amber-400 hover:text-amber-300 transition-colors disabled:opacity-50 flex items-center justify-center cursor-pointer"
                                              >
                                                <svg
                                                  className={`w-3.5 h-3.5 ${refreshingMatches[match.id] ? "animate-spin text-amber-500" : ""}`}
                                                  fill="none"
                                                  stroke="currentColor"
                                                  strokeWidth="2.5"
                                                  viewBox="0 0 24 24"
                                                >
                                                  <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
                                                  />
                                                </svg>
                                              </button>
                                            </div>
                                            {pred ? (
                                              <span className={`text-xs font-bold px-2 py-1 rounded-lg ${getPointsBadgeClass(currentPoints)}`}>
                                                +{currentPoints} Pts (Prov.)
                                              </span>
                                            ) : (
                                              <span className="text-xs font-bold px-2 py-1 rounded-lg bg-slate-950 border border-slate-850/80 text-rose-500">
                                                Sin pronóstico
                                              </span>
                                            )}
                                          </div>
                                        );
                                      }

                                      return (
                                        <button
                                          onClick={() => savePrediction(match.id)}
                                          disabled={isSaving || draft.goals1 === "" || draft.goals2 === ""}
                                          className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-850 disabled:text-slate-600 disabled:border-slate-800/80 text-slate-950 font-bold text-xs rounded-xl transition-all shadow-md active:scale-[0.95]"
                                        >
                                          {isSaving ? "Guardando..." : pred ? "Actualizar" : "Guardar"}
                                        </button>
                                      );
                                    })()}
                                  </div>

                                  {/* Running cumulative breakdown: standing before/after this match */}
                                  {pred && hasMatchStarted(match) && (
                                    <div className="mt-2 flex justify-end">
                                      <PointsBreakdown
                                        prevPoints={pred.prevPoints}
                                        matchPoints={
                                          match.result
                                            ? calculatePoints(pred.goals1, pred.goals2, match.result.goals1, match.result.goals2, match.group)
                                            : 0
                                        }
                                        afterMatchPoints={pred.afterMatchPoints}
                                        isLive={isMatchLive(match)}
                                      />
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </React.Fragment>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {activeTab === "leaderboard" && (
                <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-6">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-950/60 pb-4">
                    <div>
                      <h2 className="text-xl font-extrabold text-slate-200">Tabla de Clasificación</h2>
                      <p className="text-slate-400 text-xs mt-1">
                        Conoce a los mejores pronosticadores de la copa • <span className="text-emerald-400 font-semibold">Toca sobre cualquier jugador para auditar sus pronósticos 👁️</span>
                      </p>
                    </div>

                    {/* Group Selector Dropdown */}
                    <div className="flex items-center space-x-2 shrink-0">
                      <span className="text-xs font-semibold text-slate-400">Grupo:</span>
                      <select
                        value={selectedGroupId}
                        onChange={(e) => setSelectedGroupId(e.target.value)}
                        className="px-3 py-1.5 bg-slate-950 border border-slate-800 text-slate-350 text-xs font-semibold rounded-xl focus:outline-none focus:border-emerald-500 cursor-pointer"
                      >
                        <option value="global">🏆 Global</option>
                        {groups
                          .filter((g) => profile?.isAdmin || profile?.groupIds?.includes(g.id))
                          .map((g) => (
                            <option key={g.id} value={g.id}>👥 {g.name}</option>
                          ))
                        }
                      </select>
                    </div>
                  </div>

                  {selectedGroupId !== "global" && (
                    (() => {
                      const selGroup = groups.find(g => g.id === selectedGroupId);
                      if (!selGroup) return null;
                      const inviteUrl = typeof window !== "undefined"
                        ? `${window.location.origin}${window.location.pathname}?group=${selGroup.code}`
                        : `/?group=${selGroup.code}`;
                      return (
                        <div className="mt-4 bg-blue-500/5 border border-blue-500/20 text-blue-400 text-xs px-4 py-3 rounded-xl flex items-center justify-between gap-4">
                          <span className="truncate">🔗 <strong>Enlace de invitación:</strong> <span className="underline select-all text-blue-300">{inviteUrl}</span></span>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(inviteUrl);
                              alert("Enlace de invitación copiado al portapapeles");
                            }}
                            className="px-2.5 py-1 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 rounded-lg text-[10px] font-bold uppercase transition-all shrink-0 active:scale-95"
                          >
                            Copiar
                          </button>
                        </div>
                      );
                    })()
                  )}

                  <div className="mt-4 bg-emerald-500/5 border border-emerald-500/20 text-emerald-400 text-xs px-4 py-3 rounded-xl flex items-center space-x-2">
                    <span>🏆 <strong>Premios de la Polla:</strong> Al final del torneo, el pozo total recaudado se repartirá así: 1er Puesto: <strong>60%</strong> • 2do Puesto: <strong>30%</strong> • 3er Puesto: <strong>10%</strong>.</span>
                  </div>

                  <div className="mt-6 max-h-[270px] overflow-y-auto overflow-x-auto rounded-xl border border-slate-950 bg-slate-950/20 scrollbar-thin">
                    <table className="w-full text-left border-collapse min-w-[300px]">
                      <thead className="sticky top-0 bg-slate-950 z-10 border-b border-slate-900">
                        <tr className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                          <th className="py-3 sm:py-4 px-3 sm:px-6 text-center w-16">Pos</th>
                          <th className="py-3 sm:py-4 px-3 sm:px-6">Jugador</th>
                          <th className="py-3 sm:py-4 px-3 sm:px-6 text-right w-24">Puntos</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-950">
                        {displayedLeaderboard.map((userProf, index) => {
                          const isMe = userProf.uid === user.uid;
                          return (
                            <tr
                              key={userProf.uid}
                              className={`text-sm hover:bg-slate-900/40 transition-colors cursor-pointer group ${isMe ? "bg-emerald-500/5 text-emerald-400 font-bold" : "text-slate-355"
                                }`}
                              onClick={() => setViewingUser(userProf)}
                              title={`Ver pronósticos de ${userProf.displayName}`}
                            >
                              <td className="py-3 sm:py-4 px-3 sm:px-6 text-center font-extrabold">
                                {index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : index + 1}
                              </td>
                              <td className="py-3 sm:py-4 px-3 sm:px-6 truncate max-w-[150px] sm:max-w-[200px]">
                                <span className="align-middle hover:text-emerald-400 transition-colors">{userProf.displayName}</span>
                                <span className="inline-block ml-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity text-slate-500 text-[10px] align-middle">👁️</span>
                                {isMe && (
                                  <span className="inline-flex items-center ml-2 space-x-1.5 align-middle" onClick={(e) => e.stopPropagation()}>
                                    <span className="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded">Tú</span>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setNewDisplayName(profile?.displayName || "");
                                        setIsManualEditName(true);
                                        setShowNameRestoreModal(true);
                                      }}
                                      title="Editar mi nombre"
                                      className="text-xs text-slate-500 hover:text-emerald-400 transition-colors focus:outline-none"
                                    >
                                      ✏️
                                    </button>
                                  </span>
                                )}
                              </td>
                              <td className="py-3 sm:py-4 px-3 sm:px-6 text-right font-extrabold text-emerald-400">
                                {userProf.points}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Scoring System Information */}
                  <div className="mt-8 pt-6 border-t border-slate-800/60">
                    <h3 className="text-base font-bold text-slate-200 flex items-center space-x-2">
                      <span>🎯</span>
                      <span>Sistema de Puntuación</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">Cómo se calculan los puntos de cada partido:</p>

                    <div className="mt-3 p-3 bg-purple-500/10 border border-purple-500/20 rounded-xl flex items-center space-x-2 text-purple-300 text-xs">
                      <span className="text-sm">⚡</span>
                      <span><strong>¡Multiplicador x2!</strong> En la fase de eliminación directa (octavos de final en adelante, partido 73+), todos los puntos obtenidos se multiplican x2 (Marcador Exacto: +10 Pts, Resultado: +6 Pts, Marcador Parcial: +2 Pts).</span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4 font-sans">
                      <div className="flex items-start space-x-3 p-5 rounded-xl bg-slate-950/20 hover:bg-slate-950/40 transition-colors border border-slate-900">
                        <span className="text-sm font-bold px-2.5 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">+5 Pts</span>
                        <div>
                          <h4 className="text-sm font-bold text-slate-300">Marcador Exacto</h4>
                          <p className="text-xs text-slate-500 mt-0.5">Acertar el marcador numérico exacto.</p>
                          <span className="text-[11px] text-emerald-500/80 block mt-1">E.g., Pred: 2-1 | Real: 2-1 (o Pred: 1-1 | Real: 1-1)</span>
                        </div>
                      </div>

                      <div className="flex items-start space-x-3 p-5 rounded-xl bg-slate-950/20 hover:bg-slate-950/40 transition-colors border border-slate-900">
                        <span className="text-sm font-bold px-2.5 py-0.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 shrink-0">+3 Pts</span>
                        <div>
                          <h4 className="text-sm font-bold text-slate-300">Resultado (Ganador o Empate)</h4>
                          <p className="text-xs text-slate-500 mt-0.5">Acertar ganador o empate sin marcador exacto.</p>
                          <span className="text-[11px] text-amber-500/80 block mt-1">E.g., Pred: 2-1 | Real: 3-1 (o Pred: 1-1 | Real: 2-2)</span>
                        </div>
                      </div>

                      <div className="flex items-start space-x-3 p-5 rounded-xl bg-slate-950/20 hover:bg-slate-950/40 transition-colors border border-slate-900">
                        <span className="text-sm font-bold px-2.5 py-0.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 shrink-0">+1 Pt</span>
                        <div>
                          <h4 className="text-sm font-bold text-slate-300">Marcador Parcial</h4>
                          <p className="text-xs text-slate-500 mt-0.5">Acertar solo los goles de un equipo (cuando no se acierta el resultado).</p>
                          <span className="text-[11px] text-indigo-500/80 block mt-1">E.g., Pred: 1-2 | Real: 1-0</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB: ADMIN PANEL */}
              {activeTab === "admin" && user && (
                <div className="space-y-6">
                  {/* Admin Header & Sub-Tabs */}
                  <div className="bg-gradient-to-r from-amber-500/10 to-yellow-500/5 border border-amber-500/20 rounded-2xl p-5">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div>
                        <h2 className="text-xl font-extrabold text-amber-400">Panel de Administración</h2>
                        <p className="text-slate-400 text-xs mt-1">
                          {profile?.isAdmin
                            ? "Controla los resultados reales del mundial, ajusta las predicciones de los participantes o gestiona grupos."
                            : "Administra la membresía y parámetros de tus grupos asignados."
                          }
                        </p>
                      </div>
                      {profile?.isAdmin && (
                        <div className="flex flex-col sm:flex-row gap-2 self-start md:self-center">
                          <button
                            onClick={syncApiMatches}
                            disabled={adminSyncing}
                            className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 text-slate-950 font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-1.5"
                          >
                            {adminSyncing ? "Sincronizando..." : "⚡ Sincronizar Marcadores API"}
                          </button>
                          <button
                            onClick={recalculateAllScores}
                            disabled={adminRecalculating}
                            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 text-slate-950 font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-1.5"
                          >
                            {adminRecalculating ? "Recalculando..." : "🔄 Recalcular Todos los Puntos"}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Sub-Tabs Navigation */}
                    <div className="flex gap-2 mt-4 border-t border-slate-900 pt-4 overflow-x-auto flex-nowrap pb-2 pr-4 scrollbar-none snap-x snap-mandatory">
                      {profile?.isAdmin && (
                        <>
                          <button
                            onClick={() => setAdminSubTab("results")}
                            className={`px-4 py-2 rounded-xl text-xs font-extrabold transition-all border shrink-0 snap-start ${adminSubTab === "results"
                              ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                              : "bg-slate-950/40 border-slate-900 text-slate-400 hover:text-slate-200"
                              }`}
                          >
                            ⚽ Resultados del Mundial
                          </button>
                          <button
                            onClick={() => setAdminSubTab("predictions")}
                            className={`px-4 py-2 rounded-xl text-xs font-extrabold transition-all border shrink-0 snap-start ${adminSubTab === "predictions"
                              ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                              : "bg-slate-950/40 border-slate-900 text-slate-400 hover:text-slate-200"
                              }`}
                          >
                            👤 Pronósticos de Jugadores
                          </button>
                          <button
                            onClick={() => setAdminSubTab("users")}
                            className={`px-4 py-2 rounded-xl text-xs font-extrabold transition-all border shrink-0 snap-start ${adminSubTab === "users"
                              ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                              : "bg-slate-950/40 border-slate-900 text-slate-400 hover:text-slate-200"
                              }`}
                          >
                            🛡️ Gestionar Usuarios
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => setAdminSubTab("groups")}
                        className={`px-4 py-2 rounded-xl text-xs font-extrabold transition-all border shrink-0 snap-start ${adminSubTab === "groups"
                          ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                          : "bg-slate-950/40 border-slate-900 text-slate-400 hover:text-slate-200"
                          }`}
                      >
                        👥 Administrar Grupos
                      </button>
                      {/* Spacer for horizontal mobile scrolling */}
                      <div className="w-4 shrink-0" />
                    </div>
                  </div>

                  {/* Sub-Tab 1: Results */}
                  {adminSubTab === "results" && (
                    <div className="space-y-4">
                      {/* Round Selector in Admin for convenience */}
                      <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        <div>
                          <h3 className="font-bold text-slate-200 text-sm">Filtrar por Ronda</h3>
                          <p className="text-slate-400 text-[10px]">Filtra los partidos para registrar marcadores con mayor comodidad</p>
                        </div>
                        <div className="flex items-center gap-2 w-full md:w-auto justify-start md:justify-end">
                          {pastMatchesCount > 0 && (
                            <button
                              onClick={() => setHidePastMatchesAdmin(!hidePastMatchesAdmin)}
                              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all border flex items-center gap-1 shrink-0 ${hidePastMatchesAdmin
                                ? "bg-emerald-950/30 text-emerald-400 border-emerald-900/40 hover:bg-emerald-900/20"
                                : "bg-slate-900/60 text-slate-300 border-slate-800 hover:bg-slate-800"
                                }`}
                            >
                              {hidePastMatchesAdmin ? (
                                <>
                                  <span className="mr-1">👁️</span> {pastMatchesCount} pasados
                                </>
                              ) : (
                                <>
                                  <span>🙈</span> Ocultar
                                </>
                              )}
                            </button>
                          )}
                          <select
                            value={selectedRound}
                            onChange={(e) => setSelectedRound(e.target.value)}
                            className="px-4 py-2 bg-slate-950 border border-slate-800 text-slate-300 text-sm rounded-xl focus:outline-none focus:border-emerald-500 w-full md:w-auto"
                          >
                            {rounds.map((round) => (
                              <option key={round} value={round}>{formatRoundName(round)}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="space-y-6">
                        {groupedMatches.length === 0 ? (
                          <div className="col-span-full py-12 text-center text-slate-500 bg-slate-900/10 border border-slate-900/40 rounded-2xl p-6">
                            {pastMatchesCount > 0 && hidePastMatchesAdmin ? (
                              <>
                                <p className="text-slate-400 text-sm mb-3">Todos los partidos de esta ronda ya comenzaron o finalizaron.</p>
                                <button
                                  onClick={() => setHidePastMatchesAdmin(false)}
                                  className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-xs font-extrabold rounded-xl transition-colors shadow-lg shadow-emerald-500/20"
                                >
                                  Ver partidos pasados
                                </button>
                              </>
                            ) : (
                              "No se encontraron partidos para esta ronda."
                            )}
                          </div>
                        ) : (
                          groupedMatches.map((group) => (
                            <React.Fragment key={group.dateLabel}>
                              {/* Day Header */}
                              <div className="mt-6 first:mt-0 mb-2">
                                <div className="flex items-center space-x-3">
                                  <span className="text-[10px] font-extrabold text-amber-500 uppercase tracking-wider bg-slate-900/80 px-2.5 py-1.5 rounded-lg border border-slate-800/80 shadow-sm">
                                    {group.dateLabel}
                                  </span>
                                  <div className="h-px bg-slate-900 flex-1"></div>
                                </div>
                              </div>

                              <div className="space-y-4">
                                {group.matches.map((match) => {
                                  const draft = adminResults[match.id] || { goals1: "", goals2: "" };
                                  const isSaving = adminSaving[match.id];

                                  const matchDate = getMatchStartDate(match);
                                  const localTimeStr = matchDate.toLocaleTimeString(undefined, {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    hour12: false
                                  });
                                  const tzAbbr = getTzAbbreviation();

                                  return (
                                    <div
                                      key={match.id}
                                      className="bg-slate-900/40 border border-slate-900/80 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
                                    >
                                      <div className="flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <span className="text-xs text-amber-500 font-semibold">{formatRoundName(match.round)} • Partido {match.num}</span>
                                          {!match.group && (
                                            <span className="text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/20 px-1.5 py-0.5 rounded font-extrabold uppercase tracking-wider">
                                              x2 Puntos
                                            </span>
                                          )}
                                        </div>
                                        {editingTeamsMatchId === match.id ? (
                                          <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 mt-1.5 w-full">
                                            {/* Selects Row */}
                                            <div className="flex items-center space-x-2">
                                              <select
                                                value={editTeam1Draft}
                                                onChange={(e) => setEditTeam1Draft(e.target.value)}
                                                className="px-2 py-1 bg-slate-950 border border-slate-800 text-xs rounded-lg text-slate-200 w-[120px] focus:outline-none focus:border-amber-500 font-medium cursor-pointer"
                                              >
                                                {!availableTeams.includes(editTeam1Draft) && (
                                                  <option value={editTeam1Draft}>{editTeam1Draft}</option>
                                                )}
                                                {availableTeams.map((team) => (
                                                  <option key={team} value={team}>
                                                    {team}
                                                  </option>
                                                ))}
                                              </select>
                                              <span className="text-slate-500 text-xs font-bold shrink-0">vs</span>
                                              <select
                                                value={editTeam2Draft}
                                                onChange={(e) => setEditTeam2Draft(e.target.value)}
                                                className="px-2 py-1 bg-slate-950 border border-slate-800 text-xs rounded-lg text-slate-200 w-[120px] focus:outline-none focus:border-amber-500 font-medium cursor-pointer"
                                              >
                                                {!availableTeams.includes(editTeam2Draft) && (
                                                  <option value={editTeam2Draft}>{editTeam2Draft}</option>
                                                )}
                                                {availableTeams.map((team) => (
                                                  <option key={team} value={team}>
                                                    {team}
                                                  </option>
                                                ))}
                                              </select>
                                            </div>
                                            
                                            {/* Buttons Row */}
                                            <div className="flex items-center space-x-2">
                                              <button
                                                type="button"
                                                disabled={savingTeams}
                                                onClick={() => handleSaveTeams(match.id)}
                                                className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[10px] rounded-lg transition-all cursor-pointer flex items-center justify-center space-x-1"
                                                title="Guardar"
                                              >
                                                <span>{savingTeams ? "..." : "✓"}</span>
                                                <span className="sm:hidden text-[9px] font-bold">Guardar</span>
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  const idx = parseInt(match.id, 10) - 1;
                                                  const defaultMatch = worldCupData.matches[idx];
                                                  if (defaultMatch) {
                                                    setEditTeam1Draft(defaultMatch.team1);
                                                    setEditTeam2Draft(defaultMatch.team2);
                                                  }
                                                }}
                                                className="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-[10px] rounded-lg transition-all cursor-pointer flex items-center justify-center space-x-1"
                                                title="Restablecer original (placeholder)"
                                              >
                                                <span>🔄</span>
                                                <span className="sm:hidden text-[9px] font-bold">Revertir</span>
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => setEditingTeamsMatchId(null)}
                                                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-[10px] rounded-lg transition-all cursor-pointer flex items-center justify-center space-x-1"
                                                title="Cancelar"
                                              >
                                                <span>✕</span>
                                                <span className="sm:hidden text-[9px] font-bold">Cancelar</span>
                                              </button>
                                            </div>
                                          </div>
                                        ) : (
                                          <h3 className="font-bold text-slate-200 mt-0.5 flex items-center space-x-2">
                                            {getFlagUrl(match.team1) && (
                                              <img
                                                src={getFlagUrl(match.team1)!}
                                                alt={match.team1}
                                                className="w-5 h-3.5 object-cover rounded-sm shadow-sm border border-slate-900"
                                              />
                                            )}
                                            <span>{match.team1}</span>
                                            <span className="text-slate-500 font-semibold text-xs">vs</span>
                                            <span>{match.team2}</span>
                                            {getFlagUrl(match.team2) && (
                                              <img
                                                src={getFlagUrl(match.team2)!}
                                                alt={match.team2}
                                                className="w-5 h-3.5 object-cover rounded-sm shadow-sm border border-slate-900"
                                              />
                                            )}
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setEditingTeamsMatchId(match.id);
                                                setEditTeam1Draft(match.team1);
                                                setEditTeam2Draft(match.team2);
                                              }}
                                              className="text-amber-400/80 hover:text-amber-300 p-1 text-[11px] hover:bg-slate-800/80 rounded transition-all cursor-pointer"
                                              title="Editar Equipos"
                                            >
                                              ✏️
                                            </button>
                                          </h3>
                                        )}
                                        <span className="text-[10px] text-slate-500">{match.ground} • {localTimeStr} {tzAbbr}</span>
                                      </div>

                                      <div className="flex items-center gap-3">
                                        <div className="flex flex-col sm:flex-row items-center gap-1">
                                          <button
                                            type="button"
                                            disabled={isSaving}
                                            onClick={() => {
                                              const current = draft.goals1 === "" ? 0 : parseInt(draft.goals1, 10);
                                              const newVal = Math.max(0, isNaN(current) ? 0 : current - 1);
                                              setAdminResults(prev => ({
                                                ...prev,
                                                [match.id]: { ...draft, goals1: String(newVal) }
                                              }));
                                            }}
                                            className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 disabled:hover:bg-slate-900 disabled:hover:text-slate-400 select-none cursor-pointer order-3 sm:order-1"
                                          >
                                            -
                                          </button>
                                          <input
                                            type="text"
                                            inputMode="numeric"
                                            pattern="[0-9]*"
                                            value={draft.goals1}
                                            disabled={isSaving}
                                            onChange={(e) => {
                                              const val = e.target.value.replace(/[^0-9]/g, "");
                                              setAdminResults(prev => ({
                                                ...prev,
                                                [match.id]: { ...draft, goals1: val }
                                              }));
                                            }}
                                            className="w-9 h-9 text-center bg-slate-950 border border-slate-800 focus:border-amber-500 text-sm font-bold rounded-lg focus:outline-none text-amber-400 order-2"
                                            placeholder={match.result ? String(match.result.goals1) : "-"}
                                          />
                                          <button
                                            type="button"
                                            disabled={isSaving}
                                            onClick={() => {
                                              const current = draft.goals1 === "" ? -1 : parseInt(draft.goals1, 10);
                                              const newVal = (isNaN(current) ? -1 : current) + 1;
                                              setAdminResults(prev => ({
                                                ...prev,
                                                [match.id]: { ...draft, goals1: String(newVal) }
                                              }));
                                            }}
                                            className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 disabled:hover:bg-slate-900 disabled:hover:text-slate-400 select-none cursor-pointer order-1 sm:order-3"
                                          >
                                            +
                                          </button>
                                        </div>
                                        <span className="text-slate-600 font-bold">vs</span>
                                        <div className="flex flex-col sm:flex-row items-center gap-1">
                                          <button
                                            type="button"
                                            disabled={isSaving}
                                            onClick={() => {
                                              const current = draft.goals2 === "" ? 0 : parseInt(draft.goals2, 10);
                                              const newVal = Math.max(0, isNaN(current) ? 0 : current - 1);
                                              setAdminResults(prev => ({
                                                ...prev,
                                                [match.id]: { ...draft, goals2: String(newVal) }
                                              }));
                                            }}
                                            className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 disabled:hover:bg-slate-900 disabled:hover:text-slate-400 select-none cursor-pointer order-3 sm:order-1"
                                          >
                                            -
                                          </button>
                                          <input
                                            type="text"
                                            inputMode="numeric"
                                            pattern="[0-9]*"
                                            value={draft.goals2}
                                            disabled={isSaving}
                                            onChange={(e) => {
                                              const val = e.target.value.replace(/[^0-9]/g, "");
                                              setAdminResults(prev => ({
                                                ...prev,
                                                [match.id]: { ...draft, goals2: val }
                                              }));
                                            }}
                                            className="w-9 h-9 text-center bg-slate-950 border border-slate-800 focus:border-amber-500 text-sm font-bold rounded-lg focus:outline-none text-amber-400 order-2"
                                            placeholder={match.result ? String(match.result.goals2) : "-"}
                                          />
                                          <button
                                            type="button"
                                            disabled={isSaving}
                                            onClick={() => {
                                              const current = draft.goals2 === "" ? -1 : parseInt(draft.goals2, 10);
                                              const newVal = (isNaN(current) ? -1 : current) + 1;
                                              setAdminResults(prev => ({
                                                ...prev,
                                                [match.id]: { ...draft, goals2: String(newVal) }
                                              }));
                                            }}
                                            className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 disabled:hover:bg-slate-900 disabled:hover:text-slate-400 select-none cursor-pointer order-1 sm:order-3"
                                          >
                                            +
                                          </button>
                                        </div>

                                        <label className="flex items-center space-x-1.5 cursor-pointer select-none text-xs text-slate-300">
                                          <input
                                            type="checkbox"
                                            checked={draft.isFinal ?? true}
                                            onChange={(e) => {
                                              setAdminResults(prev => ({
                                                ...prev,
                                                [match.id]: { ...draft, isFinal: e.target.checked }
                                              }));
                                            }}
                                            className="rounded border-slate-800 text-amber-500 focus:ring-amber-500 bg-slate-950 w-4 h-4"
                                          />
                                          <span>Final</span>
                                        </label>

                                        <button
                                          onClick={() => saveMatchResult(match.id)}
                                          disabled={isSaving || draft.goals1 === "" || draft.goals2 === ""}
                                          className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-lg shadow-md disabled:opacity-50 transition-all"
                                        >
                                          {isSaving ? "Guardando..." : "Registrar"}
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </React.Fragment>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  {/* Sub-Tab 2: User Predictions Editing */}
                  {adminSubTab === "predictions" && (
                    <div className="space-y-4">
                      {/* Player and Round Selectors */}
                      <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-5 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
                        <div className="w-full md:w-auto">
                          <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">
                            Seleccionar Jugador
                          </label>
                          <select
                            value={adminSelectedUserId}
                            onChange={(e) => setAdminSelectedUserId(e.target.value)}
                            className="w-full md:w-64 px-4 py-2.5 bg-slate-950 border border-slate-800 text-slate-300 text-sm rounded-xl focus:outline-none focus:border-emerald-500"
                          >
                            <option value="">-- Selecciona un jugador --</option>
                            {leaderboard.map((userProf) => (
                              <option key={userProf.uid} value={userProf.uid}>
                                {userProf.displayName} ({userProf.email})
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="w-full md:w-auto">
                          <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">
                            Filtrar por Ronda
                          </label>
                          <div className="flex items-center gap-2 w-full md:w-auto justify-start md:justify-end">
                            {pastMatchesCount > 0 && (
                              <button
                                onClick={() => setHidePastMatchesAdmin(!hidePastMatchesAdmin)}
                                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all border flex items-center gap-1 shrink-0 ${hidePastMatchesAdmin
                                  ? "bg-emerald-950/30 text-emerald-400 border-emerald-900/40 hover:bg-emerald-900/20"
                                  : "bg-slate-900/60 text-slate-300 border-slate-800 hover:bg-slate-800"
                                  }`}
                              >
                                {hidePastMatchesAdmin ? (
                                  <>
                                    <span className="mr-1">👁️</span> {pastMatchesCount} pasados
                                  </>
                                ) : (
                                  <>
                                    <span>🙈</span> Ocultar
                                  </>
                                )}
                              </button>
                            )}
                            <select
                              value={selectedRound}
                              onChange={(e) => setSelectedRound(e.target.value)}
                              className="w-full md:w-64 px-4 py-2 bg-slate-950 border border-slate-800 text-slate-300 text-sm rounded-xl focus:outline-none focus:border-emerald-500"
                            >
                              {rounds.map((round) => (
                                <option key={round} value={round}>{formatRoundName(round)}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>

                      {/* User Matches Grid */}
                      {!adminSelectedUserId ? (
                        <div className="text-center py-16 bg-slate-900/20 border border-slate-900/50 rounded-2xl text-slate-500">
                          <span className="text-4xl block mb-2">👤</span>
                          Por favor, selecciona un jugador de la lista superior para visualizar y editar sus pronósticos.
                        </div>
                      ) : (
                        <div className="space-y-6">
                          {groupedMatches.length === 0 ? (
                            <div className="col-span-full py-12 text-center text-slate-500 bg-slate-900/10 border border-slate-900/40 rounded-2xl p-6">
                              {pastMatchesCount > 0 && hidePastMatchesAdmin ? (
                                <>
                                  <p className="text-slate-400 text-sm mb-3">Todos los partidos de esta ronda ya comenzaron o finalizaron.</p>
                                  <button
                                    onClick={() => setHidePastMatchesAdmin(false)}
                                    className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-xs font-extrabold rounded-xl transition-colors shadow-lg shadow-emerald-500/20"
                                  >
                                    Ver partidos pasados
                                  </button>
                                </>
                              ) : (
                                "No se encontraron partidos para esta ronda."
                              )}
                            </div>
                          ) : (
                            groupedMatches.map((group) => (
                              <React.Fragment key={group.dateLabel}>
                                {/* Day Header */}
                                <div className="mt-6 first:mt-0 mb-2">
                                  <div className="flex items-center space-x-3">
                                    <span className="text-[10px] font-extrabold text-amber-500 uppercase tracking-wider bg-slate-900/80 px-2.5 py-1.5 rounded-lg border border-slate-800/80 shadow-sm">
                                      {group.dateLabel}
                                    </span>
                                    <div className="h-px bg-slate-900 flex-1"></div>
                                  </div>
                                </div>

                                <div className="space-y-4">
                                  {group.matches.map((match) => {
                                    const pred = adminUserPredictions[match.id];
                                    const draft = adminUserDrafts[match.id] || { goals1: "", goals2: "" };
                                    const isSaving = adminSavingUserPreds[match.id];
                                    const hasResult = match.result != null;

                                    const matchDate = getMatchStartDate(match);
                                    const localTimeStr = matchDate.toLocaleTimeString(undefined, {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                      hour12: false
                                    });
                                    const tzAbbr = getTzAbbreviation();

                                    return (
                                      <div
                                        key={match.id}
                                        className="bg-slate-900/40 border border-slate-900/80 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
                                      >
                                        {/* Match Team Info */}
                                        <div className="flex-1">
                                          <div className="flex items-center gap-2 flex-wrap">
                                            <span className="text-xs text-amber-500 font-semibold">{formatRoundName(match.round)} • Partido {match.num}</span>
                                            {!match.group && (
                                              <span className="text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/20 px-1.5 py-0.5 rounded font-extrabold uppercase tracking-wider">
                                                x2 Puntos
                                              </span>
                                            )}
                                          </div>
                                          <h3 className="font-bold text-slate-200 mt-0.5 flex items-center space-x-2">
                                            {getFlagUrl(match.team1) && (
                                              <img
                                                src={getFlagUrl(match.team1)!}
                                                alt={match.team1}
                                                className="w-5 h-3.5 object-cover rounded-sm shadow-sm border border-slate-900"
                                              />
                                            )}
                                            <span>{match.team1}</span>
                                            <span className="text-slate-500 font-semibold text-xs">vs</span>
                                            <span>{match.team2}</span>
                                            {getFlagUrl(match.team2) && (
                                              <img
                                                src={getFlagUrl(match.team2)!}
                                                alt={match.team2}
                                                className="w-5 h-3.5 object-cover rounded-sm shadow-sm border border-slate-900"
                                              />
                                            )}
                                          </h3>
                                          <div className="flex items-center space-x-2 mt-1">
                                            <span className="text-[10px] text-slate-500">{localTimeStr} {tzAbbr} • {match.ground}</span>
                                            {hasResult && (
                                              <span className="text-[10px] bg-slate-950 border border-slate-800 text-slate-400 px-1.5 py-0.5 rounded">
                                                Resultado real: {match.result?.goals1} - {match.result?.goals2}
                                              </span>
                                            )}
                                          </div>
                                          <div className="flex items-center gap-1.5">
                                            <div className="flex flex-col sm:flex-row items-center gap-1">
                                              <button
                                                type="button"
                                                disabled={isSaving}
                                                onClick={() => {
                                                  const current = draft.goals1 === "" ? 0 : parseInt(draft.goals1, 10);
                                                  const newVal = Math.max(0, isNaN(current) ? 0 : current - 1);
                                                  setAdminUserDrafts(prev => ({
                                                    ...prev,
                                                    [match.id]: { ...draft, goals1: String(newVal) }
                                                  }));
                                                }}
                                                className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 disabled:hover:bg-slate-900 disabled:hover:text-slate-400 select-none cursor-pointer order-3 sm:order-1"
                                              >
                                                -
                                              </button>
                                              <input
                                                type="text"
                                                inputMode="numeric"
                                                pattern="[0-9]*"
                                                value={draft.goals1}
                                                disabled={isSaving}
                                                onChange={(e) => {
                                                  const val = e.target.value.replace(/[^0-9]/g, "");
                                                  setAdminUserDrafts(prev => ({
                                                    ...prev,
                                                    [match.id]: { ...draft, goals1: val }
                                                  }));
                                                }}
                                                className="w-9 h-9 text-center bg-slate-950 border border-slate-800 focus:border-amber-500 text-sm font-bold rounded-lg focus:outline-none text-slate-200 order-2"
                                                placeholder={pred ? String(pred.goals1) : "-"}
                                              />
                                              <button
                                                type="button"
                                                disabled={isSaving}
                                                onClick={() => {
                                                  const current = draft.goals1 === "" ? -1 : parseInt(draft.goals1, 10);
                                                  const newVal = (isNaN(current) ? -1 : current) + 1;
                                                  setAdminUserDrafts(prev => ({
                                                    ...prev,
                                                    [match.id]: { ...draft, goals1: String(newVal) }
                                                  }));
                                                }}
                                                className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 disabled:hover:bg-slate-900 disabled:hover:text-slate-400 select-none cursor-pointer order-1 sm:order-3"
                                              >
                                                +
                                              </button>
                                            </div>
                                            <span className="text-slate-600 font-bold text-xs">vs</span>
                                            <div className="flex flex-col sm:flex-row items-center gap-1">
                                              <button
                                                type="button"
                                                disabled={isSaving}
                                                onClick={() => {
                                                  const current = draft.goals2 === "" ? 0 : parseInt(draft.goals2, 10);
                                                  const newVal = Math.max(0, isNaN(current) ? 0 : current - 1);
                                                  setAdminUserDrafts(prev => ({
                                                    ...prev,
                                                    [match.id]: { ...draft, goals2: String(newVal) }
                                                  }));
                                                }}
                                                className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 disabled:hover:bg-slate-900 disabled:hover:text-slate-400 select-none cursor-pointer order-3 sm:order-1"
                                              >
                                                -
                                              </button>
                                              <input
                                                type="text"
                                                inputMode="numeric"
                                                pattern="[0-9]*"
                                                value={draft.goals2}
                                                disabled={isSaving}
                                                onChange={(e) => {
                                                  const val = e.target.value.replace(/[^0-9]/g, "");
                                                  setAdminUserDrafts(prev => ({
                                                    ...prev,
                                                    [match.id]: { ...draft, goals2: val }
                                                  }));
                                                }}
                                                className="w-9 h-9 text-center bg-slate-950 border border-slate-800 focus:border-amber-500 text-sm font-bold rounded-lg focus:outline-none text-slate-200 order-2"
                                                placeholder={pred ? String(pred.goals2) : "-"}
                                              />
                                              <button
                                                type="button"
                                                disabled={isSaving}
                                                onClick={() => {
                                                  const current = draft.goals2 === "" ? -1 : parseInt(draft.goals2, 10);
                                                  const newVal = (isNaN(current) ? -1 : current) + 1;
                                                  setAdminUserDrafts(prev => ({
                                                    ...prev,
                                                    [match.id]: { ...draft, goals2: String(newVal) }
                                                  }));
                                                }}
                                                className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 disabled:hover:bg-slate-900 disabled:hover:text-slate-400 select-none cursor-pointer order-1 sm:order-3"
                                              >
                                                +
                                              </button>
                                            </div>
                                          </div>

                                          {/* Points Indicator if match has result */}
                                          {hasResult && pred && (
                                            <span className={`text-xs font-bold px-2 py-1.5 rounded-lg border ${getPointsBadgeClass(pred.points)}`}>
                                              +{pred.points} Pts
                                            </span>
                                          )}

                                          <button
                                            onClick={() => saveUserPredictionByAdmin(match.id)}
                                            disabled={isSaving || draft.goals1 === "" || draft.goals2 === ""}
                                            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-lg shadow-md disabled:opacity-50 transition-all"
                                          >
                                            {isSaving ? "Guardando..." : pred ? "Modificar" : "Asignar"}
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </React.Fragment>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {adminSubTab === "groups" && (
                    <div className="space-y-4">
                      {/* Sub-tabs for groups admin: list / create */}
                      <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-4 flex items-center justify-between">
                        <div className="flex space-x-2">
                          <button
                            onClick={() => setAdminGroupSubTab("list")}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${adminGroupSubTab === "list"
                              ? "bg-amber-500 text-slate-950"
                              : "bg-slate-950 text-slate-400 hover:text-slate-200"
                              }`}
                          >
                            Listado de Grupos
                          </button>
                          <button
                            onClick={() => setAdminGroupSubTab("create")}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${adminGroupSubTab === "create"
                              ? "bg-amber-500 text-slate-950"
                              : "bg-slate-950 text-slate-400 hover:text-slate-200"
                              }`}
                          >
                            + Crear Nuevo Grupo
                          </button>
                        </div>
                      </div>

                      {adminGroupSubTab === "create" && (
                        <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-5 space-y-4">
                          <h3 className="font-extrabold text-slate-200 text-sm">Crear un Nuevo Grupo</h3>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Nombre del Grupo</label>
                              <input
                                type="text"
                                value={newGroupName}
                                onChange={(e) => {
                                  setNewGroupName(e.target.value);
                                  // Auto-generate code
                                  setNewGroupCode(e.target.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-"));
                                }}
                                className="w-full px-4 py-2 bg-slate-950 border border-slate-800 text-slate-250 rounded-xl focus:outline-none focus:border-amber-500 text-sm"
                                placeholder="Ej. Amigos de la Oficina"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Código de Invitación (Slug único)</label>
                              <input
                                type="text"
                                value={newGroupCode}
                                onChange={(e) => setNewGroupCode(e.target.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-"))}
                                className="w-full px-4 py-2 bg-slate-950 border border-slate-800 text-slate-250 rounded-xl focus:outline-none focus:border-amber-500 text-sm"
                                placeholder="ej-amigos-oficina"
                              />
                            </div>
                          </div>
                          <button
                            onClick={handleCreateGroup}
                            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-xl shadow-md transition-all active:scale-95"
                          >
                            Crear Grupo
                          </button>
                        </div>
                      )}

                      {adminGroupSubTab === "list" && (
                        <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-5">
                          <h3 className="font-extrabold text-slate-200 text-sm mb-4">Grupos Existentes</h3>
                          {(() => {
                            const myManagedGroups = groups.filter((g) => profile?.isAdmin || (user && g.admins?.includes(user.uid)));
                            if (myManagedGroups.length === 0) {
                              return (
                                <p className="text-slate-500 text-xs">
                                  No administras ningún grupo todavía. ¡Ve a la pestaña "+ Crear Nuevo Grupo" arriba para crear tu propio grupo y jugar con tus amigos!
                                </p>
                              );
                            }
                            return (
                              <div className="overflow-x-auto">
                                <table className="w-full text-left border-collapse">
                                  <thead>
                                    <tr className="border-b border-slate-800 text-slate-400 text-[10px] font-bold uppercase tracking-wider">
                                      <th className="py-2 px-3">Nombre</th>
                                      <th className="py-2 px-3">Código</th>
                                      <th className="py-2 px-3 text-right">Acciones</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-900 text-xs text-slate-300">
                                    {myManagedGroups.map((g) => (
                                      <tr key={g.id} className="hover:bg-slate-900/20">
                                        <td className="py-3 px-3 font-semibold">{g.name}</td>
                                        <td className="py-3 px-3 text-slate-400 select-all">{g.code}</td>
                                        <td className="py-3 px-3">
                                          <div className="flex flex-col sm:flex-row justify-end items-end sm:items-center gap-1.5 sm:gap-2">
                                            <button
                                              onClick={() => {
                                                const inviteUrl = typeof window !== "undefined"
                                                  ? `${window.location.origin}${window.location.pathname}?group=${g.code}`
                                                  : `/?group=${g.code}`;
                                                navigator.clipboard.writeText(inviteUrl);
                                                alert(`Enlace de invitación para el grupo "${g.name}" copiado.`);
                                              }}
                                              className="px-2 py-1 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 rounded-lg text-[10px] font-bold text-blue-400 whitespace-nowrap"
                                            >
                                              Copiar Enlace de invitación
                                            </button>
                                            <button
                                              onClick={() => setAdminSelectedGroupId(adminSelectedGroupId === g.id ? "" : g.id)}
                                              className="px-2 py-1 bg-slate-950 border border-slate-800 rounded-lg hover:border-slate-750 text-[10px] font-bold text-slate-350 whitespace-nowrap"
                                            >
                                              {adminSelectedGroupId === g.id ? "Ocultar Miembros" : "Ver Miembros"}
                                            </button>
                                            {(profile?.isAdmin || (user && g.admins?.includes(user.uid))) && (
                                              <button
                                                onClick={() => handleDeleteGroup(g.id)}
                                                className="px-2 py-1 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 rounded-lg text-[10px] font-bold text-rose-400 whitespace-nowrap"
                                              >
                                                Eliminar
                                              </button>
                                            )}
                                          </div>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            );
                          })()}
                        </div>
                      )}

                      {adminSelectedGroupId && (
                        (() => {
                          const activeGroup = groups.find((g) => g.id === adminSelectedGroupId);
                          const groupMembers = leaderboard.filter((u) => u.groupIds?.includes(adminSelectedGroupId));
                          if (!activeGroup) return null;
                          return (
                            <div ref={membersSectionRef} className="bg-slate-900/40 border border-slate-900 rounded-2xl p-5 space-y-4">
                              <div className="flex flex-col gap-3 border-b border-slate-800 pb-3">
                                <div>
                                  <h3 className="font-extrabold text-slate-200 text-sm">Miembros de: {activeGroup.name}</h3>
                                  <p className="text-slate-500 text-[10px]">Total: {groupMembers.length} jugadores</p>
                                </div>
                                <div className="flex flex-col sm:flex-row gap-2 w-full">
                                  <select
                                    id="add-user-select"
                                    className="flex-1 px-3 py-1.5 bg-slate-950 border border-slate-800 text-slate-350 text-sm rounded-lg w-full focus:outline-none focus:border-emerald-500 max-w-full"
                                  >
                                    <option value="">-- Agregar Jugador --</option>
                                    {leaderboard
                                      .filter((u) => !u.groupIds?.includes(adminSelectedGroupId))
                                      .map((u) => (
                                        <option key={u.uid} value={u.uid}>
                                          {u.displayName} ({u.email})
                                        </option>
                                      ))}
                                  </select>
                                  <button
                                    onClick={async () => {
                                      const selectEl = document.getElementById("add-user-select") as HTMLSelectElement;
                                      const userIdToAdd = selectEl?.value;
                                      if (!userIdToAdd) return;
                                      await handleAddUserToGroup(userIdToAdd, adminSelectedGroupId);
                                      selectEl.value = "";
                                    }}
                                    className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-lg transition-all whitespace-nowrap"
                                  >
                                    Agregar
                                  </button>
                                </div>
                              </div>

                              {groupMembers.length === 0 ? (
                                <p className="text-slate-500 text-xs">Este grupo no tiene miembros asignados.</p>
                              ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                  {groupMembers.map((member) => {
                                    const isGrpAdmin = activeGroup.admins?.includes(member.uid) ?? false;
                                    return (
                                      <div key={member.uid} className="flex justify-between items-center p-2.5 bg-slate-950/40 rounded-xl border border-slate-900/80">
                                        <div className="truncate pr-2">
                                          <p className="font-bold text-slate-250 text-xs flex items-center space-x-1.5">
                                            <span>{member.displayName}</span>
                                            {isGrpAdmin && (
                                              <span className="text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1 py-0.2 rounded font-extrabold uppercase">
                                                Admin
                                              </span>
                                            )}
                                          </p>
                                          <p className="text-[10px] text-slate-500">{member.email}</p>
                                        </div>
                                        <div className="flex items-center space-x-1.5 shrink-0">
                                          {isGrpAdmin ? (
                                            <button
                                              onClick={() => handleDemoteFromGroupAdmin(member.uid, activeGroup.id)}
                                              className="px-2 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/20 rounded-lg text-[9px] font-bold uppercase transition-colors"
                                            >
                                              Quitar Admin
                                            </button>
                                          ) : (
                                            <button
                                              onClick={() => handlePromoteToGroupAdmin(member.uid, activeGroup.id)}
                                              className="px-2 py-1 bg-slate-950 border border-slate-800 hover:border-slate-700 text-slate-350 rounded-lg text-[9px] font-bold uppercase transition-colors"
                                            >
                                              Hacer Admin
                                            </button>
                                          )}
                                          <button
                                            onClick={() => handleRemoveUserFromGroup(member.uid, adminSelectedGroupId)}
                                            className="px-2 py-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/10 rounded-lg text-[9px] font-bold uppercase transition-colors"
                                          >
                                            Quitar
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })()
                      )}
                    </div>
                  )}

                  {adminSubTab === "users" && profile?.isAdmin && (
                    <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-5 space-y-4">
                      <h3 className="font-extrabold text-slate-200 text-sm">Gestionar Usuarios Registrados</h3>
                      <p className="text-slate-500 text-xs">Lista completa de participantes en la plataforma. Elimina usuarios no autorizados para quitarlos de la polla y del ranking.</p>

                      <div className="overflow-x-auto rounded-xl border border-slate-950 bg-slate-950/20">
                        <table className="w-full text-left border-collapse min-w-[400px]">
                          <thead>
                            <tr className="bg-slate-900/60 text-slate-400 text-xs font-semibold uppercase tracking-wider">
                              <th className="py-3 px-4">Jugador</th>
                              <th className="py-3 px-4">Correo</th>
                              <th className="py-3 px-4 text-center">Puntos</th>
                              <th className="py-3 px-4 text-right">Acciones</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-950 text-slate-350 text-xs">
                            {leaderboard.map((u) => {
                              const isMe = u.uid === user?.uid;
                              return (
                                <tr key={u.uid} className="hover:bg-slate-900/20">
                                  <td className="py-3 px-4 font-bold">{u.displayName} {isMe && "(Tú)"}</td>
                                  <td className="py-3 px-4 text-slate-450">{u.email}</td>
                                  <td className="py-3 px-4 text-center font-extrabold text-emerald-400">{u.points}</td>
                                  <td className="py-3 px-4 text-right space-x-2">
                                    <button
                                      onClick={() => handleEditUserDisplayName(u.uid)}
                                      className="px-2.5 py-1.5 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 rounded-lg text-[10px] font-bold text-indigo-400 uppercase tracking-wide transition-all"
                                    >
                                      Editar Nombre
                                    </button>
                                    <button
                                      onClick={() => handleForceDeleteUser(u.uid)}
                                      disabled={isMe}
                                      className="px-2.5 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 rounded-lg text-[10px] font-bold text-rose-400 uppercase tracking-wide disabled:opacity-30 disabled:hover:bg-transparent transition-all"
                                    >
                                      Eliminar
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </main>

      {/* Modal de Disculpas y Actualización de Nombre */}
      {showNameRestoreModal && (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 pt-20 sm:pt-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 max-w-md w-full shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="text-center space-y-2">
              <span className="text-4xl">{isManualEditName ? "👤" : "🙏"}</span>
              <h2 className="text-xl font-black text-slate-100 bg-gradient-to-r from-emerald-400 to-amber-300 bg-clip-text text-transparent">
                {isManualEditName ? "Editar mi Nombre" : "¡Mil Disculpas!"}
              </h2>
              <p className="text-xs text-slate-350 leading-relaxed">
                {isManualEditName
                  ? "Actualiza tu nombre de pantalla para que aparezca correctamente en la clasificación."
                  : "Debido a una actualización del sistema, de forma temporal se restablecieron algunos nombres en pantalla y se asignó tu correo."}
              </p>
              {!isManualEditName && (
                <p className="text-xs text-emerald-400 font-bold">
                  Te invitamos a escribir tu nombre real abajo para que todos te reconozcan en la tabla de clasificación.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">Tu Nombre de Pantalla</label>
              <input
                type="text"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder="Ej: Juan Pérez"
                className="w-full px-4 py-2.5 bg-slate-950/50 border border-slate-800 rounded-xl focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 text-slate-100 text-xs transition-colors"
              />
            </div>

            <div className="flex space-x-3 pt-2">
              <button
                onClick={() => {
                  localStorage.setItem("polla_name_restore_alert_shown", "true");
                  setShowNameRestoreModal(false);
                }}
                className="flex-1 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 font-bold rounded-xl text-xs transition-all"
              >
                {isManualEditName ? "Cancelar" : "Omitir"}
              </button>
              <button
                onClick={async () => {
                  const clean = newDisplayName.trim();
                  if (!clean) {
                    alert("El nombre no puede estar vacío.");
                    return;
                  }
                  setUpdatingOwnName(true);
                  try {
                    if (user) {
                      await setDoc(doc(db, "users", user.uid), { displayName: clean }, { merge: true });
                      localStorage.setItem("polla_name_restore_alert_shown", "true");
                      setShowNameRestoreModal(false);
                    }
                  } catch (err) {
                    console.error(err);
                    alert("Error al actualizar tu nombre.");
                  } finally {
                    setUpdatingOwnName(false);
                  }
                }}
                disabled={updatingOwnName}
                className="flex-[2] py-2 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-slate-950 font-bold rounded-xl text-xs transition-all disabled:opacity-50 flex items-center justify-center"
              >
                {updatingOwnName ? "Guardando..." : "Guardar Nombre"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Historial de Pronósticos de otro Usuario */}
      {viewingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-955/85 backdrop-blur-md animate-in fade-in duration-200">
          <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 max-w-2xl w-full shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-200 max-h-[90vh] flex flex-col">

            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-4 shrink-0">
              <div className="space-y-1">
                <h2 className="text-lg sm:text-xl font-black text-slate-100 flex items-center gap-2">
                  <span>🏆</span>
                  <span>Pronósticos de {viewingUser.displayName}</span>
                </h2>
                <p className="text-xs text-slate-400">
                  Total de puntos calculados: <span className="text-emerald-400 font-extrabold">{viewingUser.points} Pts</span>
                </p>
              </div>
              <button
                onClick={() => {
                  setViewingUser(null);
                  setViewingUserFilter("started");
                }}
                className="text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 w-8 h-8 rounded-full flex items-center justify-center transition-colors font-bold"
              >
                ✕
              </button>
            </div>

            {/* Filter Tabs */}
            <div className="flex gap-2 shrink-0 bg-slate-950/50 p-1 rounded-xl border border-slate-800/60 w-fit">
              <button
                onClick={() => setViewingUserFilter("started")}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${viewingUserFilter === "started"
                  ? "bg-emerald-500 text-slate-950 shadow-md"
                  : "text-slate-400 hover:text-slate-200"
                  }`}
              >
                ⚡ Partidos Iniciados / Finalizados
              </button>
              <button
                onClick={() => setViewingUserFilter("all")}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${viewingUserFilter === "all"
                  ? "bg-emerald-500 text-slate-950 shadow-md"
                  : "text-slate-400 hover:text-slate-200"
                  }`}
              >
                📅 Todos los Partidos
              </button>
            </div>

            {/* Match List */}
            <div className="flex-1 overflow-y-auto space-y-3 pr-1 scrollbar-thin scrollbar-thumb-slate-800">
              {viewingUserPredsLoading ? (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400 space-y-3">
                  <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
                  <p className="text-xs font-semibold animate-pulse">Cargando pronósticos...</p>
                </div>
              ) : (() => {
                let filteredList = sortedMatches.filter(match => {
                  if (viewingUserFilter === "started") {
                    return hasMatchStarted(match);
                  }
                  return true;
                });

                if (viewingUserFilter === "started") {
                  filteredList = [...filteredList].sort((a, b) => {
                    const dateA = getMatchStartDate(a).getTime();
                    const dateB = getMatchStartDate(b).getTime();
                    if (dateA !== dateB) {
                      return dateB - dateA;
                    }
                    return b.num - a.num;
                  });
                }

                if (filteredList.length === 0) {
                  return (
                    <div className="text-center py-12 text-slate-500 text-sm">
                      No hay partidos en esta categoría aún.
                    </div>
                  );
                }

                return filteredList.map(match => {
                  const pred = viewingUserPredictions.find(p => p.matchId === match.id);
                  const hasStarted = hasMatchStarted(match);
                  const hasResult = match.result != null;

                  const matchDate = getMatchStartDate(match);
                  const localTimeStr = matchDate.toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                  });
                  const tzAbbr = getTzAbbreviation();

                  // Compute live state once for use in layout
                  const isFinalCard = match.result != null && match.result.isFinal !== false;
                  const isLiveCard = isMatchLive(match);
                  const liveGoals1Card = match.result ? match.result.goals1 : 0;
                  const liveGoals2Card = match.result ? match.result.goals2 : 0;

                  return (
                    <div key={match.id} className="bg-slate-955/45 border border-slate-850 rounded-2xl p-4 flex flex-col gap-3 hover:bg-slate-955/80 transition-colors">

                      {/* Top section: round label + badges, team names — all centered */}
                      <div className="flex flex-col items-center gap-1.5">
                        {/* Round / group + live badge */}
                        <div className="flex items-center gap-2 flex-wrap justify-center">
                          <span className="text-[10px] text-emerald-400 font-extrabold uppercase tracking-wider flex items-center gap-1.5">
                            <span>{formatRoundName(match.round)} {match.group ? `• ${match.group}` : ""}</span>
                            {!match.group && (
                              <span className="text-[9px] bg-purple-500/10 text-purple-400 border border-purple-500/20 px-1.5 py-0.5 rounded font-extrabold uppercase tracking-wider">
                                x2 Puntos
                              </span>
                            )}
                          </span>
                          {isLiveCard && (
                            <span className="text-[9px] bg-amber-500/15 border border-amber-500/30 text-amber-500 px-1.5 py-0.5 rounded font-bold flex items-center gap-1 animate-pulse">
                              <span className="w-1 h-1 rounded-full bg-amber-500 animate-ping"></span>
                              ⚡ En Juego
                            </span>
                          )}
                        </div>
                        {/* Teams */}
                        <div className="font-extrabold text-sm text-slate-200 flex items-center gap-2 flex-wrap justify-center">
                          {getFlagUrl(match.team1) && (
                            <img src={getFlagUrl(match.team1)!} alt={match.team1} className="w-5 h-3.5 object-cover rounded-sm border border-slate-900 shrink-0" />
                          )}
                          <span>{match.team1}</span>
                          <span className="text-slate-500 font-bold text-xs shrink-0">vs</span>
                          <span>{match.team2}</span>
                          {getFlagUrl(match.team2) && (
                            <img src={getFlagUrl(match.team2)!} alt={match.team2} className="w-5 h-3.5 object-cover rounded-sm border border-slate-900 shrink-0" />
                          )}
                        </div>
                        {/* Time (upcoming) or Final result — centered below teams */}
                        {!hasStarted && (
                          <span className="text-[10px] text-slate-500 font-semibold">{localTimeStr} {tzAbbr}</span>
                        )}
                        {isFinalCard && (
                          <span className="text-[11px] bg-slate-900/60 border border-slate-800 text-slate-300 px-2 py-1 rounded-lg font-bold">
                            Final: {match.result?.goals1} - {match.result?.goals2}
                          </span>
                        )}
                      </div>

                      {/* Bottom row: only shown for started matches — live badge on left, prediction on right */}
                      {hasStarted && (
                        <div className="flex items-center justify-center gap-3 flex-wrap">
                          {/* Live score badge — only shown when match is live */}
                          {isLiveCard && (
                            <div className="inline-flex items-center bg-slate-950 border border-slate-800 rounded-xl overflow-hidden whitespace-nowrap">
                              <span className="text-[11px] text-slate-100 font-bold px-2.5 py-1">
                                En Vivo: <span className="text-amber-400 font-extrabold">{liveGoals1Card} - {liveGoals2Card}</span>
                              </span>
                              <div className="w-px h-5 bg-slate-800"></div>
                              <button
                                onClick={() => refreshLiveMatchScore(match.id)}
                                disabled={refreshingMatches[match.id]}
                                title="Actualizar marcador"
                                className="px-2 py-1 hover:bg-slate-900 text-amber-400 hover:text-amber-300 transition-colors disabled:opacity-50 flex items-center justify-center cursor-pointer"
                              >
                                <svg
                                  className={`w-3.5 h-3.5 ${refreshingMatches[match.id] ? "animate-spin text-amber-500" : ""}`}
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
                                  />
                                </svg>
                              </button>
                            </div>
                          )}

                          {/* User prediction + points */}
                          <div className="flex items-center gap-2">
                            {pred ? (
                              (() => {
                                const currentPoints = calculatePoints(pred.goals1, pred.goals2, liveGoals1Card, liveGoals2Card, match.group);
                                return (
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs bg-slate-900 border border-slate-800 text-emerald-450 px-2 py-1 rounded-lg font-bold font-mono">
                                      {pred.goals1} - {pred.goals2}
                                    </span>
                                    <span className={`text-[10px] font-bold px-2 py-1 rounded-lg border ${getPointsBadgeClass(currentPoints)}`}>
                                      +{currentPoints} Pts {match.result?.isFinal === false ? "(Prov.)" : ""}
                                    </span>
                                  </div>
                                );
                              })()
                            ) : (
                              <span className="text-[10px] text-rose-500 font-bold bg-rose-500/5 px-2.5 py-1 rounded-lg border border-rose-500/10">Sin pronóstico</span>
                            )}
                          </div>

                          {/* Running cumulative breakdown: standing before/after this match */}
                          {pred && (
                            <div className="w-full flex justify-center">
                              <PointsBreakdown
                                prevPoints={pred.prevPoints}
                                matchPoints={
                                  match.result
                                    ? calculatePoints(pred.goals1, pred.goals2, liveGoals1Card, liveGoals2Card, match.group)
                                    : 0
                                }
                                afterMatchPoints={pred.afterMatchPoints}
                                isLive={isLiveCard}
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {/* Not started: show "locked" badge */}
                      {!hasStarted && (
                        <div className="flex justify-end">
                          <div className="flex items-center gap-1 text-[10px] text-slate-500 bg-slate-900/40 px-2.5 py-1 rounded-lg border border-slate-800/60 font-extrabold uppercase tracking-wider">
                            <span>🔒 Oculto</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>

            {/* Modal Footer */}
            <div className="pt-2 border-t border-slate-800 flex items-center justify-between gap-3 shrink-0">
              {profile?.isAdmin ? (
                <button
                  onClick={() => recalculateUserScores(viewingUser)}
                  disabled={recalculatingUserId === viewingUser.uid}
                  title="Recorre las predicciones de este usuario en orden y corrige su acumulado"
                  className="px-4 py-2.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-400 font-bold rounded-xl text-xs transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  {recalculatingUserId === viewingUser.uid ? "Recalculando..." : "🔄 Recalcular este usuario"}
                </button>
              ) : (
                <span />
              )}
              <button
                onClick={() => {
                  setViewingUser(null);
                  setViewingUserFilter("started");
                }}
                className="px-5 py-2.5 bg-slate-800 hover:bg-slate-750 text-slate-200 font-bold rounded-xl text-xs transition-all active:scale-[0.98]"
              >
                Cerrar
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Modal de Historial de Partidos de un Equipo */}
      {selectedTeamHistory && (() => {
        const teamMatches = matches
          .filter(
            (m) =>
              (m.team1 === selectedTeamHistory || m.team2 === selectedTeamHistory) &&
              m.result !== null
          )
          .sort((a, b) => {
            const dateA = getMatchStartDate(a).getTime();
            const dateB = getMatchStartDate(b).getTime();
            return dateB - dateA;
          });

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-955/85 backdrop-blur-md animate-in fade-in duration-200">
            <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 max-w-lg w-full shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-200 max-h-[85vh] flex flex-col">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-slate-800 pb-4 shrink-0">
                <div className="flex items-center space-x-3">
                  {getFlagUrl(selectedTeamHistory) && (
                    <img
                      src={getFlagUrl(selectedTeamHistory)!}
                      alt={selectedTeamHistory}
                      className="w-10 h-7 object-cover rounded shadow-md border border-slate-950"
                    />
                  )}
                  <div>
                    <h2 className="text-lg sm:text-xl font-black text-slate-100">
                      {selectedTeamHistory}
                    </h2>
                    <p className="text-xs text-slate-400">Historial en el Mundial</p>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedTeamHistory(null)}
                  className="text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 w-8 h-8 rounded-full flex items-center justify-center transition-colors font-bold cursor-pointer"
                >
                  ✕
                </button>
              </div>

              {/* Match list */}
              <div className="flex-1 overflow-y-auto space-y-3 pr-1 scrollbar-thin scrollbar-thumb-slate-800">
                {teamMatches.length === 0 ? (
                  <div className="text-center py-12 text-slate-500 text-sm flex flex-col items-center justify-center gap-2">
                    <span className="text-2xl">⚽</span>
                    <p>Este equipo aún no ha jugado partidos finalizados en este mundial.</p>
                  </div>
                ) : (
                  teamMatches.map((m) => {
                    const isTeam1 = m.team1 === selectedTeamHistory;
                    const teamGoals = isTeam1 ? m.result!.goals1 : m.result!.goals2;
                    const oppGoals = isTeam1 ? m.result!.goals2 : m.result!.goals1;
                    const oppName = isTeam1 ? m.team2 : m.team1;

                    let outcome: "win" | "draw" | "loss";
                    if (teamGoals > oppGoals) outcome = "win";
                    else if (teamGoals < oppGoals) outcome = "loss";
                    else outcome = "draw";

                    const outcomeConfig = {
                      win: {
                        label: "Victoria",
                        classes: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
                        dot: "bg-emerald-400",
                      },
                      draw: {
                        label: "Empate",
                        classes: "bg-slate-500/10 border-slate-500/30 text-slate-400",
                        dot: "bg-slate-400",
                      },
                      loss: {
                        label: "Derrota",
                        classes: "bg-rose-500/10 border-rose-500/30 text-rose-400",
                        dot: "bg-rose-400",
                      },
                    }[outcome];

                    const matchDate = getMatchStartDate(m);
                    const formattedDate = matchDate.toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                    });

                    return (
                      <div
                        key={m.id}
                        className="bg-slate-950/40 border border-slate-850/80 rounded-2xl p-4 flex flex-col gap-3 hover:bg-slate-955/80 transition-all"
                      >
                        {/* Match header info */}
                        <div className="flex items-center justify-between text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                          <span>{formatRoundName(m.round)}</span>
                          <span>{formattedDate}</span>
                        </div>

                        {/* Match Content */}
                        <div className="flex items-center justify-between gap-3">
                          {/* Selected Team */}
                          <div className="flex-1 flex items-center gap-2 min-w-0">
                            {getFlagUrl(selectedTeamHistory) && (
                              <img
                                src={getFlagUrl(selectedTeamHistory)!}
                                alt={selectedTeamHistory}
                                className="w-5 h-3.5 object-cover rounded-sm border border-slate-955 shrink-0"
                              />
                            )}
                            <span className="font-extrabold text-xs sm:text-sm text-slate-200 truncate">
                              {selectedTeamHistory}
                            </span>
                          </div>

                          {/* Score and result badge */}
                          <div className="flex flex-col items-center shrink-0">
                            <span className="text-sm font-black text-slate-100 bg-slate-950 border border-slate-800/80 px-2.5 py-1 rounded-xl">
                              {teamGoals} - {oppGoals}
                            </span>
                            <span className={`inline-flex items-center gap-1 text-[9px] font-extrabold px-1.5 py-0.5 rounded border mt-1.5 ${outcomeConfig.classes}`}>
                              <span className={`w-1 h-1 rounded-full ${outcomeConfig.dot}`}></span>
                              {outcomeConfig.label}
                            </span>
                          </div>

                          {/* Opponent */}
                          <div className="flex-1 flex items-center justify-end gap-2 min-w-0">
                            <span className="font-semibold text-xs sm:text-sm text-slate-400 truncate text-right">
                              {oppName}
                            </span>
                            {getFlagUrl(oppName) && (
                              <img
                                src={getFlagUrl(oppName)!}
                                alt={oppName}
                                className="w-5 h-3.5 object-cover rounded-sm border border-slate-955 shrink-0"
                              />
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Footer */}
              <div className="pt-2 border-t border-slate-800 flex justify-end shrink-0">
                <button
                  onClick={() => setSelectedTeamHistory(null)}
                  className="px-5 py-2.5 bg-slate-800 hover:bg-slate-750 text-slate-200 font-bold rounded-xl text-xs transition-all active:scale-[0.98] cursor-pointer"
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-[9999] animate-in fade-in slide-in-from-bottom-5 duration-300">
          <div className={`px-4 py-3 rounded-2xl border backdrop-blur-xl shadow-2xl flex items-center gap-2.5 text-xs font-bold ${toast.type === "success" ? "bg-emerald-950/80 text-emerald-400 border-emerald-500/20" :
            toast.type === "error" ? "bg-rose-950/80 text-rose-400 border-rose-500/20" :
              "bg-slate-900/80 text-slate-350 border-slate-800"
            }`}>
            <span className="text-sm">{toast.type === "success" ? "🏆" : toast.type === "error" ? "❌" : "ℹ️"}</span>
            <span>{toast.message}</span>
            <button
              onClick={() => setToast(null)}
              className="ml-2 text-slate-400 hover:text-white transition-colors font-extrabold"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
