// Prompt-Vorgaben fuer die Preset-Schritte.
//
// 19.09.2026, Entscheid des Inhabers: ein leeres Feld hilft niemandem. Neben dem
// Modell steht eine Liste von Anfaengen, die der Kunde anklickt und dann mit
// eigenen Worten weiterschreibt. Die Vorgabe ersetzt seinen Text nie, sie
// haengt sich davor, damit beides zusammen rausgeht.
//
// Die Texte sind auf Echtheit geschrieben und nicht auf Effekt: Kamera,
// Licht, Material, Traegermedium. Das ist, was diese Endpunkte lesen.

import type { StepRole } from './preset-models'

export interface PromptIdea { label: string; text: string }

/** Was im Bild zu sehen ist. Nach Kategorie, weil ein Produktfoto andere
 *  Anfaenge braucht als eine Kreatur. */
const SCENE: Record<string, PromptIdea[]> = {
  Horror: [
    { label: 'Found footage', text: 'photorealistic, handheld camcorder footage from 1998, VHS grain and tracking lines, a motionless figure at the far end of a hallway, flashlight the only light' },
    { label: 'Phone POV at night', text: 'photorealistic, shot on a phone at night, POV, shaky frame, the flash reaching only two metres, wet concrete stairwell, something crouched just past the light' },
    { label: 'Doorbell camera', text: 'photorealistic, fisheye doorbell camera still with a timestamp in the corner, infrared night mode, a tall thin figure standing far too close to the lens, face out of focus' },
    { label: 'Clinical close-up', text: 'photorealistic clinical close-up under cold fluorescent light, skin stretched over shapes that do not belong beneath it, medical photography, unflinching detail' },
    { label: 'Abandoned ward', text: 'photorealistic, abandoned psychiatric ward, peeling paint, rusted bed frames, damp ceiling, one bare bulb swinging, dust caught in the beam, nobody in frame' },
    { label: 'Trail camera', text: 'photorealistic, trail camera photograph at 3 a.m., infrared, birch forest, a pale long-limbed animal caught mid-stride, eyes reflecting the flash' },
    { label: 'Basement', text: 'photorealistic, a cold concrete basement lit by candles, chalk marks on the floor, a figure kneeling with its back turned, film photograph, heavy shadows' },
    { label: 'Under the water', text: 'photorealistic, underwater in murky green lake water, a pale hand and long hair rising out of the silt, sunlight breaking through in shafts, cold and silent' },
    { label: 'The morning after', text: 'photorealistic, kitchen at dawn, overturned chair, dark stains across the linoleum, breakfast still on the table, documentary photograph, nobody in frame' },
    { label: 'Handmade mask', text: 'photorealistic, close portrait of a person in a crude handmade mask of stitched cloth and bone, flat overcast daylight, rural field behind, 35mm film' },
  ],
  Character: [
    { label: 'Phone POV', text: 'photorealistic, shot on a phone, POV, natural window light, candid and slightly off balance, realistic skin texture, mild motion blur' },
    { label: 'Golden hour', text: 'photorealistic, portrait in low golden hour sun, warm rim light through the hair, shallow depth of field, 85mm, soft grain' },
    { label: 'Neon alley', text: 'photorealistic, standing in a narrow alley at night, wet asphalt, magenta and cyan neon from a sign overhead, cinematic, 35mm' },
    { label: 'Film noir', text: 'photorealistic, black and white, hard side light through window blinds, cigarette smoke drifting, deep shadows, 1940s studio photograph' },
    { label: 'Lamp light', text: 'photorealistic, sitting on the edge of a bed in warm bedside lamp light, dark room behind, strong rim light, cinematic still, shallow depth of field' },
    { label: 'Studio beauty', text: 'photorealistic, clean studio beauty shot, soft key light with a large softbox, seamless grey backdrop, sharp detail in the eyes' },
    { label: 'Rain on glass', text: 'photorealistic, seen through a rain-covered window at night, city lights out of focus behind, reflections on the glass, moody and quiet' },
    { label: 'Backstage mirror', text: 'photorealistic, backstage at a mirror ringed with bulbs, half in costume, warm tungsten light, candid documentary photograph' },
    { label: 'Rooftop summer', text: 'photorealistic, on a rooftop in late summer heat, hazy skyline behind, hard midday sun, 35mm colour film, natural skin' },
    { label: 'Monochrome 35mm', text: 'black and white 35mm film portrait, visible grain, available light only, direct eye contact, honest and unretouched' },
  ],
  Product: [
    { label: 'Studio white', text: 'photorealistic, product on a seamless white backdrop, soft even studio light, gentle contact shadow, commercial catalogue photograph' },
    { label: 'Marble and shadow', text: 'photorealistic, product on polished marble, hard directional sun casting a long sharp shadow, minimal styling, editorial still life' },
    { label: 'Kitchen counter', text: 'photorealistic, product on a kitchen counter in morning light, shallow depth of field, a few real props out of focus behind' },
    { label: 'Outdoors in use', text: 'photorealistic, product held outdoors in natural daylight, lifestyle photograph, hands in frame, blurred park background' },
    { label: 'Water and splash', text: 'photorealistic, product with water droplets and a frozen splash, high speed flash, dark background, glossy highlights' },
    { label: 'Neon gradient', text: 'photorealistic, product lit by a magenta to cyan gradient, dark reflective surface, crisp edges, modern advertising look' },
    { label: 'Wooden desk', text: 'photorealistic, flat lay on a worn wooden desk, overhead shot, soft window light, notebook and pen arranged around it' },
    { label: 'In the hand', text: 'photorealistic, close-up of the product held in a hand, natural skin, soft daylight, shallow focus on the label' },
    { label: 'Macro texture', text: 'photorealistic, macro shot of the product surface, raking light across the texture, extreme detail, dark surroundings' },
    { label: 'On the shelf', text: 'photorealistic, product on a retail shelf among others, slightly wide lens, store lighting, documentary rather than staged' },
  ],
  Video: [
    { label: 'Phone POV', text: 'shot on a phone, POV, handheld, natural light, candid and unpolished' },
    { label: 'Slow push in', text: 'a slow steady push in toward the subject, locked horizon, cinematic, shallow depth of field' },
    { label: 'Handheld follow', text: 'handheld camera following just behind the subject, slight sway, documentary feel' },
    { label: 'Orbit', text: 'the camera orbits slowly around the subject at eye level, background sliding past, even pace' },
    { label: 'Locked off', text: 'static locked-off shot on a tripod, only the subject moves, patient and observational' },
    { label: 'Drone pull back', text: 'the camera pulls back and up, revealing the wider landscape around the subject' },
    { label: 'Rack focus', text: 'focus pulls from the foreground detail to the subject behind, shallow depth of field, 50mm' },
    { label: 'Low angle', text: 'low angle looking up at the subject, wide lens, sky behind, slow drift to the left' },
    { label: 'Night drive', text: 'from inside a moving car at night, streetlights sweeping across, reflections on the windscreen' },
    { label: 'Golden hour walk', text: 'walking toward the low sun, long shadows, lens flare, warm handheld footage' },
  ],
}

/** Wie sich das Bild bewegt.
 *
 *  19.09.2026: ein Kunde schrieb "the bird is starting to sing and looks
 *  stressed" und bekam einen Vogel, der stillsteht. Diese Endpunkte lesen
 *  BEWEGUNG, keine Absicht und keine Stimmung. Die Haelfte der Anfaenge
 *  beschreibt deshalb, was das Motiv tut, und nicht nur, was die Kamera tut. */
const MOTION: PromptIdea[] = [
  { label: 'Looks into camera', text: 'the subject slowly turns its head toward the camera and holds the look, small natural movements' },
  { label: 'Opens mouth, sings', text: 'the subject opens its mouth and sings, the head tilts, the throat moves, the body shifts slightly with each note' },
  { label: 'Speaks', text: 'the subject speaks, the mouth moves clearly, small head movements, the eyes stay on the camera' },
  { label: 'Breathes and blinks', text: 'small natural movement only, the chest rises and falls, the eyes blink, hair and fabric shift slightly' },
  { label: 'Steps forward', text: 'the subject takes two slow steps toward the camera and stops, the camera holds still' },
  { label: 'Wind', text: 'wind moves through hair and fabric, the subject stays where it is and looks ahead' },
  { label: 'Slow push in', text: 'a slow steady push in toward the subject, locked horizon, cinematic, shallow depth of field' },
  { label: 'Handheld follow', text: 'handheld camera following just behind the subject, slight sway, documentary feel' },
  { label: 'Orbit', text: 'the camera orbits slowly around the subject at eye level, background sliding past, even pace' },
  { label: 'Locked off', text: 'static locked-off shot on a tripod, only the subject moves, patient and observational' },
]

/** Was zu hoeren ist. */
const SOUND: PromptIdea[] = [
  { label: 'Room tone', text: 'quiet room tone, distant traffic, a clock ticking somewhere off screen' },
  { label: 'Footsteps', text: 'slow wet footsteps on concrete, echo of a large empty space, a single drip' },
  { label: 'Wind and trees', text: 'wind moving through trees, leaves, a bird call far away' },
  { label: 'Breathing', text: 'close unsteady breathing, fabric rustling, a floorboard creaking under weight' },
  { label: 'City street', text: 'busy city street, passing cars, voices in the distance, a siren several blocks away' },
  { label: 'Rain on glass', text: 'heavy rain against a window, thunder rolling far off, the hum of a fridge' },
  { label: 'Machinery', text: 'low industrial hum, metal ticking as it cools, a fan turning somewhere above' },
  { label: 'Crowd', text: 'indoor crowd murmur, glasses and cutlery, a door opening and closing' },
  { label: 'Water', text: 'water lapping against stone, a boat rope straining, gulls overhead' },
  { label: 'Silence and one sound', text: 'almost complete silence, then one sharp sound very close to the microphone' },
]

/** Was mit dem Bild passieren soll. */
const SETTING: PromptIdea[] = [
  { label: 'Marble surface', text: 'place it on polished marble in hard directional sunlight with a long sharp shadow' },
  { label: 'Kitchen morning', text: 'put it on a kitchen counter in soft morning light with a blurred window behind' },
  { label: 'Outdoors', text: 'set it outdoors on grass in natural daylight with a blurred treeline behind' },
  { label: 'Dark and glossy', text: 'set it on a dark reflective surface with a magenta to cyan gradient behind it' },
  { label: 'Wooden desk', text: 'place it on a worn wooden desk seen from above in soft window light' },
  { label: 'Retail shelf', text: 'place it on a retail shelf among other goods under store lighting' },
  { label: 'Studio white', text: 'put it on a seamless white studio backdrop with soft even light and a gentle contact shadow' },
  { label: 'Concrete and shadow', text: 'set it on raw concrete with hard late afternoon light raking across the texture' },
  { label: 'Held in a hand', text: 'show it held in a hand in soft daylight with the background thrown out of focus' },
  { label: 'Rain', text: 'set it outside in the rain with water beading on the surface and grey overcast light' },
]

/** Die Anfaenge fuer diesen Schritt. Leer heisst: das Feld beschreibt hier
 *  keine Szene, und eine Vorgabe waere geraten statt hilfreich. */
export function promptIdeas(role: StepRole, category: string): PromptIdea[] {
  if (role === 'image') return SCENE[category] ?? SCENE.Character
  if (role === 'animate' || role === 'extend') return MOTION
  if (role === 'soundtrack') return SOUND
  if (role === 'edit') return SETTING
  return []
}

export interface IdeaGroup { label: string; ideas: PromptIdea[] }

/** Die Anfaenge im normalen Create-Fenster.
 *
 *  Dort gibt es keine Preset-Kategorie, also entscheidet die Absicht. Beim
 *  Bild bleiben die vier Sets als Gruppen stehen, damit der Kunde sieht, dass
 *  es sie gibt; bei Video zaehlt nur die Bewegung, bei Musik nur der Klang. */
export function createIdeas(intent: string): IdeaGroup[] {
  if (intent === 'video' || intent === 'animate' || intent === 'extend') return [{ label: 'Movement', ideas: MOTION }]
  if (intent === 'music') return [{ label: 'Sound', ideas: SOUND }]
  if (intent === 'image' || intent === 'edit') {
    return (['Horror', 'Character', 'Product', 'Video'] as const)
      .map((label) => ({ label, ideas: SCENE[label] }))
      .filter((g) => g.ideas?.length)
  }
  return []
}
