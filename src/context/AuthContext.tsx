"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { 
  onAuthStateChanged, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  User,
  sendPasswordResetEmail
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  points: number;
  isAdmin?: boolean;
  groupIds?: string[];
}

export interface SavedAccount {
  email: string;
  name: string;
  pass: string;
}

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  savedAccounts: SavedAccount[];
  login: (email: string, pass: string) => Promise<void>;
  signup: (email: string, pass: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  switchAccount: (email: string) => Promise<void>;
  removeSavedAccount: (email: string) => void;
  resetPassword: (email: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>([]);

  useEffect(() => {
    // Timeout check: if loading is still true after 8 seconds, force sign out and let user log in manually
    const forceTimeout = setTimeout(async () => {
      if (loading) {
        console.warn("Loading state got stuck. Clearing session...");
        try {
          await signOut(auth);
        } catch (e) {
          console.error("Error signing out during stuck loading:", e);
        }
        setProfile(null);
        setUser(null);
        setLoading(false);
      }
    }, 8000);

    return () => clearTimeout(forceTimeout);
  }, [loading]);

  useEffect(() => {
    // Cargar cuentas guardadas desde localStorage
    try {
      const stored = localStorage.getItem("polla_saved_accounts");
      if (stored) {
        setSavedAccounts(JSON.parse(stored));
      }
    } catch (e) {
      console.error("Error loading saved accounts:", e);
    }

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        // Fetch user profile from Firestore
        const userDocRef = doc(db, "users", firebaseUser.uid);
        const userDocSnap = await getDoc(userDocRef);
        if (userDocSnap.exists()) {
          setProfile(userDocSnap.data() as UserProfile);
        } else {
          // If the profile does not exist (e.g. deleted by admin), sign out
          await signOut(auth);
          setProfile(null);
          alert("Esta cuenta ha sido desactivada o eliminada por el administrador.");
        }
      } else {
        setProfile(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const saveAccountInfo = (email: string, pass: string, name: string) => {
    try {
      const stored = localStorage.getItem("polla_saved_accounts");
      const list: SavedAccount[] = stored ? JSON.parse(stored) : [];
      const filtered = list.filter(acc => acc.email !== email);
      filtered.push({ email, name, pass });
      // Guardamos un máximo de 5 cuentas
      if (filtered.length > 5) filtered.shift();
      localStorage.setItem("polla_saved_accounts", JSON.stringify(filtered));
      setSavedAccounts(filtered);
    } catch (e) {
      console.error("Error saving account info:", e);
    }
  };

  const login = async (email: string, pass: string) => {
    setLoading(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email, pass);
      
      // Obtener el perfil para el nombre
      const userDocRef = doc(db, "users", cred.user.uid);
      const userDocSnap = await getDoc(userDocRef);
      const displayName = userDocSnap.exists() 
        ? (userDocSnap.data() as UserProfile).displayName 
        : email.split("@")[0];

      saveAccountInfo(email, pass, displayName);
    } catch (error) {
      setLoading(false);
      throw error;
    }
  };

  const signup = async (email: string, pass: string, name: string) => {
    setLoading(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      const newProfile: UserProfile = {
        uid: cred.user.uid,
        email: email,
        displayName: name,
        points: 0,
      };
      await setDoc(doc(db, "users", cred.user.uid), newProfile);
      setProfile(newProfile);
      saveAccountInfo(email, pass, name);
    } catch (error) {
      setLoading(false);
      throw error;
    }
  };

  const logout = async () => {
    setLoading(true);
    await signOut(auth);
  };

  const switchAccount = async (email: string) => {
    const acc = savedAccounts.find(a => a.email === email);
    if (!acc) return;
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, acc.email, acc.pass);
    } catch (error) {
      setLoading(false);
      throw error;
    }
  };

  const removeSavedAccount = (email: string) => {
    const filtered = savedAccounts.filter(a => a.email !== email);
    localStorage.setItem("polla_saved_accounts", JSON.stringify(filtered));
    setSavedAccounts(filtered);
  };

  const resetPassword = async (email: string) => {
    await sendPasswordResetEmail(auth, email);
  };

  return (
    <AuthContext.Provider value={{ 
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
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
