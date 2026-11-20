// The account's content rule, read from the server like the Create tab reads
// it. Nothing is cached here: the tools ask once per call.
import { getContentPolicy, type ContentPolicy } from '../../../api/cloud/jobs'

/** A failed read is the strictest answer that still lets ordinary requests
 *  through ('soft'): it never opens what the account has not opened. */
export async function loadContentPolicy(): Promise<ContentPolicy> {
  try {
    return (await getContentPolicy()).policy
  } catch {
    return 'soft'
  }
}
