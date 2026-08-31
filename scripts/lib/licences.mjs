/**
 * Which licences oblige us to say where the source is.
 *
 * The pack's `.mrpack` only names files, but the client and server zips carry
 * the real jars — so those archives convey compiled code, and the copyleft
 * family asks that whoever receives it can obtain the source too. We host no
 * source ourselves; naming where the project publishes it is what answers that.
 *
 * Matching is on the licence id Modrinth reports, which is SPDX for anything
 * with an SPDX id and `LicenseRef-*` otherwise. GPL, LGPL, AGPL and MPL are all
 * matched: MPL is weaker (file-level rather than whole-work) but still asks for
 * the source of the files it covers, so it belongs on the same list.
 */
const COPYLEFT = /^(A?GPL|LGPL|MPL)-/i;

export function isCopyleft(license) {
  return typeof license === 'string' && COPYLEFT.test(license);
}
