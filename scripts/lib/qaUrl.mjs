/**
 * The app URL the QA harnesses drive. Set GEV_QA_URL to point them at
 * another server; a harness's `--url` still overrides it for one run.
 */
export const QA_DEFAULT_URL = 'http://localhost:4173';

/**
 * @param {Record<string, string | undefined>} [environment]
 * @returns {string} The app URL, without a trailing slash.
 */
export function qaUrl(environment = process.env) {
  return (environment.GEV_QA_URL || QA_DEFAULT_URL).replace(/\/+$/, '');
}
