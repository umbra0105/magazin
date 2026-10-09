import { assertTestDatabase, assertTestRedis } from "./test-env";

// Rulează înaintea fiecărui fișier de test de integrare: dacă mediul indică baza sau Redis-ul de
// dezvoltare, testele nu pornesc deloc (ele șterg date).
assertTestDatabase(process.env["DATABASE_URL"]);
assertTestRedis(process.env["REDIS_URL"]);
