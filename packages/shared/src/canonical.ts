/**
 * Canonical JSON deterministik (addendum §13).
 * Key diurutkan rekursif sehingga objek dengan isi sama — apapun urutan
 * key-nya — ter-serialize identik. Dipakai untuk dedup evidence
 * (`canonicalHash` di @harness/evidence) dan evidence block deterministik
 * (prompt.ts, addendum §17).
 */
export function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortKeys);
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = sortKeys((obj as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return obj;
}

/** Serialisasi deterministik: key terurut. */
export function canonicalJson(data: unknown): string {
  return JSON.stringify(sortKeys(data));
}
