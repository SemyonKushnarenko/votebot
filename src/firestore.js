import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export function getDb() {
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }
  return getFirestore();
}

