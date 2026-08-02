/**
 * The request path, normalised once, for the two guards that match on it.
 *
 * Both uses are allow-lists -- `AuthGuard`'s always-public probes and
 * `DemoReadOnlyGuard`'s permitted writes -- so the normalisation is part of a
 * security decision, and two copies of it that drift is exactly the way an
 * allow-list stops meaning what it says. One function, one behaviour, one place
 * to look when a route does not match.
 */

/** Path without the query string, and without a trailing slash except at the root. */
export function pathOf(url: string): string {
  const [path] = url.split('?');
  if (path === undefined || path.length === 0) {
    return '/';
  }
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
