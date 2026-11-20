import { useCloudAuthStore } from '../stores/cloudAuthStore'

/**
 * Das Etikett der Freimengenmarke, an genau einer Stelle.
 *
 * Am 12.09.2026: die Marke heisst wieder "No credits". "Included" sagte
 * nicht, was der Kunde davon hat, sondern nur, dass etwas dabei ist, und das
 * steht an jedem zweiten Tarif im Netz. Dass die Marke am KONTO haengt und
 * nicht am Modell, traegt die Logik daneben (sie zeichnet nur bei laufendem
 * Abo) und der Merksatz im Titel, nicht mehr das Etikett.
 *
 * Der Wortlaut steht hier, damit ein Wortwechsel eine Zeile bleibt und nicht
 * drei Stellen im JSX sucht. Das Web nimmt denselben.
 */
export const FLASH_MARK_LABEL = 'No credits'

/**
 * Der Titel an der Marke, Wortlaut vom 12.09.2026, zeichengleich mit dem Web.
 * Die Tagesgrenze kommt vom Server und wird nie hier getippt.
 */
export const flashMarkTitle = (dailyTokens: number): string =>
  `No credits on your plan, up to ${dailyTokens.toLocaleString('en-US')} tokens per day.`

/** Der Satz, den ein Konto ohne bezahlten Plan liest. Wortgleich mit dem Web. */
export const FLASH_UNPAID_NOTICE = 'Flash models are free on a paid plan. This account uses credits.'

/**
 * Bekommt DIESES Konto die Freimenge?
 *
 * Die Regel ist `accountPlanPays`, und die Tatsache, die sie braucht, ob je
 * Geld angekommen ist, liegt in der Datenbank. Die Antwort wird deshalb geholt
 * und nicht im Klienten nachgerechnet: `/api/me` fuehrt genau die Funktion aus,
 * die der Chat-Vermittler vor dem Abrechnen einer Runde fuehrt. Eine Regel,
 * eine Antwort, damit eine Marke auf dem Schirm nicht verspricht, was die
 * Rechnung danach widerlegt.
 *
 * `null` heisst "noch nicht beantwortet", und jede Oberflaeche liest das als
 * "verspricht nichts", nie als Ja. Der Desktop fragt die Route ohnehin im
 * Takt ab (`hooks/useCloudAuth`), der Wert steht deshalb im Kontospeicher und
 * braucht keine zweite Abfrage.
 */
export function useFlashEntitlement(): boolean | null {
  return useCloudAuthStore((s) => s.paidPlan)
}
