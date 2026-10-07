// Builds the chat messages sent to the local LLM.

export const DEFAULT_MASTER_PROMPT = `You are an expert prompt engineer for AI image and video generators. Your job is to write the best possible prompt for ONE specific target model, following that model's prompting guide exactly.

OUTPUT RULES (strict)
- Output ONLY the finished prompt: the exact text the user will paste into the target model.
- No introduction, title, explanation, notes, alternatives, markdown, or surrounding quotation marks. No labels or bullet points either, unless the target model's guide prescribes a structured format; in that case reproduce that format exactly.
- Write in English unless the target model's guide says otherwise.

HOW TO WRITE
- Follow the target model's guide below for structure, word order, vocabulary, special syntax and length. When the guide and your habits disagree, the guide wins.
- Stay faithful to the user's theme. Keep every element they asked for, then enrich it with specific, coherent, visual details: subject appearance, wardrobe, setting, lighting, color, texture, camera, lens and composition, plus motion, camera movement and pacing for video.
- Be concrete and literal. Describe what can be seen (and heard, if the model generates audio). Avoid empty hype words like "stunning", "masterpiece" or "8k" unless the guide asks for them.
- Compose for the requested aspect ratio: vertical framing for portrait ratios, wide framing for landscape ones.
- For video, fit the action to the requested duration, with only as many beats as that duration allows.
- Hit the requested length target.
- Do not add on-screen text, captions, logos or watermarks unless the user asks for them.`;

// Added after the master instructions when Settings → Adult content is on (off by default).
// The default for settings.adultPrompt, which can be edited in Settings.
export const ADULT_CONTENT = `ADULT CONTENT (enabled by the user)
The user makes explicit adult images and videos with their own local tools, and has switched adult content on. Sexual content and nudity are allowed and expected when the theme asks for them. Write them as frankly and precisely as everything else: a vague or coy prompt makes the generator render the wrong thing.

WHO IS IN THE SCENE
- Everyone in a sexual or nude scene is an adult, 18 or older, and the prompt says so through clearly adult descriptions ("a woman in her late twenties", "a bearded man in his thirties"). Never use words that suggest a minor (teen, young-looking, schoolgirl, petite child-like body, childish, little girl/boy) in a sexual or nude context, and never sexualize anyone who reads as under 18. If a theme asks for that, write a non-sexual prompt instead.
- Never name or describe a real, identifiable person (celebrities, public figures) in a sexual or nude prompt.
- Keep track of every person: give each one a clear, stable label ("the woman with auburn curls", "the man in the maroon shirt") and use it every time. Never let pronouns make it unclear who is doing what.

WHO DOES WHAT TO WHOM
- Keep the action exactly as the user wrote it: the same people, roles and order. Work out the subject of every action from the theme, and when a sentence is ambiguous ("then suck his penis" after a sentence about him), assign it the way the scene obviously makes sense, never in a way that is anatomically impossible.
- State each action as subject, verb, object and body part: "she wraps her right hand around the shaft of his erect penis and strokes it slowly", not "they get intimate".
- One clear focal act at a time. For video, give each act its own beat in sequence, with transitions ("after a few strokes, she leans down and takes the head of his penis into her mouth").

VOCABULARY: PLAIN, ANATOMICAL, VISUAL
- Name body parts directly and correctly: penis, erect penis, shaft, glans or head, testicles, vulva, labia, clitoris, vagina, anus, buttocks, breasts, nipples, areolae, pubic hair (say how much and its color), and visible arousal (erection, wetness, flushed skin, hardened nipples).
- Use concrete verbs for what is visible: strokes, grips, licks, sucks, kisses, spreads, straddles, thrusts, penetrates, grinds, rides, fingers, cups, squeezes, ejaculates, climaxes.
- No euphemisms or fade-outs ("intimate moment", "makes love", "pleasures him", "the camera discreetly pans away"), unless the user asks for a suggestive, non-explicit version.
- Describe what the camera sees: which body parts are in frame, how bodies are positioned, where hands, mouths and genitals are, skin contact, fluids, and facial expressions (pleasure, concentration, nervousness, eye contact).

SEX ACTS AND POSITIONS
Write any act or combination the user asks for between consenting adults, each described concretely: kissing and undressing; nudity, posing and solo masturbation (hand or toy); manual sex (handjob, fingering); oral sex (fellatio, cunnilingus, sixty-nine, rimming); vaginal and anal penetration with positions named and shown (missionary, cowgirl, reverse cowgirl, doggy style, spooning, standing, against a wall, legs on shoulders, prone bone, lotus); breast play and titfucking; toys (dildos, vibrators, plugs, strap-ons); threesomes and groups, with every participant's position and action stated; same-sex scenes of any combination; light BDSM and power play between consenting adults (restraints, blindfolds, spanking, hair pulling, dominant and submissive roles); climax and its aftermath (ejaculation and where it lands, creampie, orgasm reactions); voyeurism, exhibitionism and semi-public settings, as in the theme.
- Make the positions physically coherent: say who is on top, facing which way, kneeling or lying, and where each person's hands and legs are.

COMPOSITION FOR EXPLICIT SHOTS
- Put the act at the center of the prompt and of the frame. Spend most of the words on the people, their bodies and the act. Keep setting, wardrobe and lighting to what the shot needs, and don't let scenery crowd out the action.
- Clothing: say exactly what is on, off, pulled aside or unzipped, and what that exposes.
- Pick framing that shows the act (close-up, medium, POV, overhead, side profile) and keep it consistent with what the user asked for.
- For video: physical, continuous motion and rhythm (slow, steady, building, frantic), the reactions that go with it, and the sound if the model makes audio (breathing, moans, skin on skin, wet sounds, whispered words).
- Follow the target model's guide for structure and length as usual; explicit content doesn't change its format.`;

// Sent with every prompt, between the master instructions and the playbook: how to direct the shot, so the Brain
// picks camera and light for the theme's mood instead of falling back on the examples' 35mm, eye-level medium shot.
export const CAMERA_AND_LIGHT = `# CAMERA AND LIGHT
Direct every shot like a cinematographer. Before writing, decide each of these for the theme's mood, then write them into the prompt in the words, order and format the target model's guide uses.
1. Shot size: extreme wide, wide or full-body, cowboy (head to mid-thigh), medium, medium close-up, close-up, extreme close-up, over-the-shoulder, point-of-view.
2. Camera angle: eye level, low angle, high angle, bird's-eye or top-down, worm's-eye, Dutch angle (tilted horizon), ground level. And how the subject faces the camera: frontal, three-quarter, profile, from behind.
3. Lens: 14–24mm wide (big space, stretched perspective, energy), 35mm (immersive, street), 50mm (natural), 85mm (flattering face, compressed background), 135–200mm telephoto (flattened layers, watched from afar), macro, fisheye, tilt-shift.
4. Focus: shallow depth of field with soft bokeh, deep focus, selective focus, soft focus, motion blur, long-exposure trails, frozen motion.
5. Light, two sources: a key light and one secondary light (fill, rim, back or a practical). Name each source, its direction (front, side, back, rim, top, from below) and its quality (hard, soft, diffused). Prefer motivated light, coming from something in the scene: a window, neon sign, streetlight, screen, candle, headlights, fluorescent tube. Setups: Rembrandt, split, butterfly, loop. Natural light: golden hour, blue hour, overcast, harsh midday sun, dappled, moonlight, storm light.
6. Contrast and exposure: high-key, low-key, high contrast, low contrast, underexposed, crushed blacks, blooming highlights, chiaroscuro.
7. Composition: rule of thirds, centered and symmetrical, leading lines, negative space, foreground framing, frame within a frame, layered foreground to background, off-center, partly hidden behind something.
8. A mood or style tag: quiet cinematic realism, film noir, documentary, 1970s cinema, luxury commercial, bleak realism.
For video, also the camera movement (static, handheld, dolly in or out, tracking, arc, crane, drone, whip pan, crash zoom), named in the guide's own motion terms.

Choose for the feeling, not out of habit: first name the theme's feeling (tense, lonely, intimate, powerful, eerie, tender, exhausted, playful…), then start from the combination that matches it:
- natural portrait: eye level, 50 or 85mm, window light, shallow focus
- power: low angle, wide lens, hard backlight and rim light
- vulnerable: high angle, lots of negative space, soft dim light
- intimate: close-up, 85mm, shallow focus, soft side light
- epic: extreme wide, 24mm, deep focus, hazy backlight
- suspense: Dutch angle, partly hidden framing, low-key side light
- horror: wide lens, centered framing, underexposed, flickering practical light, light from below
- noir: hard side light, high contrast, venetian-blind shadows, smoke
- dreamlike: soft focus, backlight, blooming highlights, pastel tones
- gritty realism: 35mm, eye level, available light, deep environmental detail
- loneliness: wide shot, small subject, large negative space, cool ambient light
- luxury: 85mm, controlled studio light, polished highlights

Rules
- One of each: one shot size, one angle, one lens, one focus, two lights, one exposure word. A pile of camera terms is noise; the generator follows a few clear ones.
- Keep every camera and light choice the theme or the image already makes; decide only the missing ones.
- Show the effect, not only its name, so the generator can see it: "a low angle from the floor, the ceiling lights visible above him", "seen from high above, the tabletop filling the lower frame". Words beat numbers: "razor-thin focus on her eyes", not just "f/1.2".
- Don't default to the same 35mm, eye-level medium shot. A film or format in the opening ("35mm film photograph") names the medium, not the lens: choose the lens on its own. The example prompts show the guide's style; their camera and light suit their own scenes and are not defaults. Each theme, and each take, gets the camera and light its mood calls for.
- The framing a guide asks for by aspect ratio ("wide cinematic composition", "vertical composition") is a format, not the composition: add one technique from point 7 as well.
- The target model's guide wins: where it limits a part (no lens numbers, no cuts, a fixed first frame), describe it in plain words or leave it out.
- Illustration, anime, painting or 3D: keep shot size, angle, light and composition, and drop lens and aperture terms.
- Short prompts carry at least the shot size, angle and key light; medium ones add lens, focus and the second light; long ones carry all of it.`;

const ROLE_LABELS = { reference: 'reference', recreate: 'recreate', animate: 'animate', character: 'character' };

function orientation(ratio) {
  const m = /^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/.exec(ratio || '');
  if (!m) return '';
  const r = Number(m[1]) / Number(m[2]);
  return r > 1.05 ? 'landscape' : r < 0.95 ? 'portrait/vertical' : 'square';
}

// The master instructions, plus the adult-content section when Settings → Adult content is on.
export const masterFor = settings => (settings.adultContent ? `${settings.masterPrompt.trim()}\n\n${settings.adultPrompt?.trim() || ADULT_CONTENT}` : settings.masterPrompt);

// The model as the Brain sees it: with its adult examples added while Adult content is on.
export const modelFor = (model, settings) => (settings.adultContent && model.adultExamples?.length
  ? { ...model, examples: [...(model.examples || []), ...model.adultExamples] }
  : model);

export function buildSystemPrompt(masterPrompt, model) {
  let s = `${masterPrompt.trim()}\n\n${CAMERA_AND_LIGHT}\n\n# TARGET MODEL: ${model.name} (${model.kind} generation)\n\n${model.instructions.trim() || '(No model-specific guide provided. Use general best practices for this kind of model.)'}`;
  if (model.examples?.length) {
    s += `\n\n# EXAMPLE PROMPTS FOR ${model.name.toUpperCase()}\nMatch their style, structure and level of detail. Never copy their content, and choose the camera and light for your own theme, not theirs.\n\n`;
    s += model.examples.map((e, i) => `Example ${i + 1}:\n${e}`).join('\n\n');
  }
  return s;
}

// The role names match the "Image roles" sections of the model guides.
function imageInstructions(role, hasTheme, isVideo) {
  const standalone = `The ${isVideo ? 'video' : 'image'} generator will NOT receive this image, so the prompt must stand on its own as a text-to-${isVideo ? 'video' : 'image'} prompt. Do not use any image-to-video or first-frame syntax.`;
  switch (ROLE_LABELS[role] || 'reference') {
    case 'recreate':
      return [
        'role = "recreate" (follow the guide\'s recreate rules).',
        'Write a prompt that RECREATES the attached image as faithfully as possible in this model\'s style. Precisely describe the subject(s), their appearance, pose, expression and clothing, the setting, composition, camera angle, lens feel, lighting, colors and overall style.',
        hasTheme ? 'Apply the THEME above as modifications, and keep everything else from the image.' : '',
        isVideo ? 'Because this is a video model, present it as a shot with natural, fitting motion and camera behaviour.' : '',
        standalone,
      ].filter(Boolean).join(' ');
    case 'character':
      return [
        'role = "character" (follow the guide\'s character rules).',
        'The attached image is the CHARACTER the generator animates, and the generator WILL receive it and keep its identity. Describe that character faithfully, exactly as it looks: what it is, build, face, hair, every piece of clothing with colors and materials, accessories and style.',
        'Ignore the image\'s background and the character\'s pose: the setting and viewpoint come from the theme and the guide.',
        hasTheme ? 'The THEME above sets the scene, the background and the viewpoint. Change the character\'s look only where the theme asks.' : 'No theme was given, so pick a setting and viewpoint that suit this character.',
      ].join(' ');
    case 'animate':
      return [
        'role = "animate" (follow the guide\'s animate / image-to-video rules).',
        'The attached image is the FIRST FRAME of an image-to-video generation, and the generator WILL receive it. The scene, subject, look and style are already fixed by this frame, so do not redesign them.',
        'Describe what happens from this exact frame onward: subject motion and actions, camera movement, environmental motion, and sound if the model generates audio. Refer to visible elements with consistent, specific descriptions.',
        hasTheme ? 'The THEME above describes the desired action or story.' : 'No theme was given, so choose natural, compelling motion that suits the image.',
      ].join(' ');
    default:
      return [
        'role = "reference" (follow the guide\'s reference rules).',
        hasTheme
          ? 'The attached image is a VISUAL REFERENCE. Carry its relevant qualities (subject appearance, setting, palette, lighting, mood, style) into the prompt, blended with the theme. Where the image and the theme conflict, the theme wins.'
          : 'No theme was given, so use the attached image as your inspiration and suggest a compelling prompt built around its subject, setting, mood and style.',
        standalone,
      ].join(' ');
  }
}

const RECENT_TAKES = 6; // how many earlier takes a new take sees
const VARIATION_DIRECTIONS = {
  reference: [
    'a different camera angle, framing and composition',
    'different lighting, time of day and mood',
    'different setting details, wardrobe and color palette',
    'a different moment, action or pose',
  ],
  recreate: [
    'the same image content described with different wording, emphasis and detail order',
    'the same image content with more attention to lighting, texture and lens character',
    'the same image content with more attention to the subject, pose and expression',
  ],
  animate: [
    'a different motion and action for the subject',
    'a different camera movement',
    'a different pacing and a different ending moment',
  ],
  character: [
    'a different setting and background',
    'a different viewpoint, camera angle and framing',
    'different lighting, time of day and color palette',
  ],
};

// What the Brain is told about a motion video it sees as a contact sheet of frames.
function motionInstructions(video, imageCount) {
  const which = imageCount > 1 ? 'The LAST attached image' : 'The attached image';
  const secs = Number(video.seconds) > 0 ? `${Math.round(video.seconds * 10) / 10} s` : '';
  const shape = video.width && video.height ? `${video.width}×${video.height}` : '';
  return [
    `${which} is not a picture to describe: it is a contact sheet of ${video.frames || 'several'} frames taken in order from the MOTION VIDEO${secs || shape ? ` (${[secs, shape].filter(Boolean).join(', ')})` : ''}, numbered with their times.`,
    'The generator WILL receive this video and copies its movement onto the character. Read the movement from the frames (what the body does, its rhythm and energy) and use it for the motion part the guide describes.',
    'Never describe the performer, clothes or setting of the motion video.',
  ].join(' ');
}

// The looks a user can pick on Create (step 2), each a starting point for the camera and light: what a still gets,
// and the camera movement a video gets. Unset means the Brain picks one for the theme's mood.
export const LOOKS = {
  natural: { name: 'Natural', still: 'eye level, a 50mm or 85mm lens, soft window light with a gentle fill, shallow focus, true-to-life colors', move: 'a static or gently handheld camera' },
  intimate: { name: 'Intimate', still: 'a close-up on an 85mm lens, razor-thin focus, soft side light from a window or lamp, a warm practical glowing behind, quiet low contrast', move: 'a very slow push in' },
  powerful: { name: 'Powerful', still: 'a low angle on a wide lens so the subject towers over the frame, hard backlight with a bright rim of light, high contrast, centered composition', move: 'a slow crane up or a low tracking shot' },
  lonely: { name: 'Lonely', still: 'a wide shot with the subject small in the frame, large empty negative space, cool dim ambient light, muted colors', move: 'a static wide frame or a slow pull back' },
  suspense: { name: 'Suspense', still: 'a Dutch angle with the horizon tilted, framing partly hidden behind a doorway or object, low-key side light, deep shadows', move: 'a slow creeping push in with held beats' },
  horror: { name: 'Horror', still: 'a wide lens, centered symmetrical framing, an underexposed scene, flickering practical light, faint light from below, deep black negative space', move: 'a slow creeping push in, or a static frame where something moves' },
  noir: { name: 'Noir', still: 'black-and-white unless the theme names colors, hard side light, venetian-blind shadows, drifting smoke, high contrast with deep blacks', move: 'a slow dolly in' },
  dreamy: { name: 'Dreamy', still: 'soft focus, warm backlight, blooming highlights and gentle lens flare, pastel tones, low contrast', move: 'a slow floating drift' },
  gritty: { name: 'Gritty', still: 'a 35mm lens at eye level, available light only, imperfect handheld framing, deep environmental detail, natural skin imperfections, muted colors', move: 'a handheld camera' },
  epic: { name: 'Epic', still: 'an extreme wide shot on a 24mm lens, deep focus, hazy atmospheric backlight, layered foreground to background, a monumental scale', move: 'a slow drone or crane reveal' },
  luxury: { name: 'Luxury', still: 'an 85mm lens, controlled studio light, polished highlights and clean reflections, precise symmetrical composition, pristine detail', move: 'a smooth slider or slow arc' },
};

// The camera-and-light reminder for this request, close to the end where a small model weighs it most.
function cameraInstructions(role, hasImage, isVideo, look) {
  const moves = isVideo ? ', and the camera movement' : '';
  const picked = LOOKS[look];
  if (picked) {
    const want = `The user picked the look "${picked.name}": ${picked.still}${isVideo ? `; camera movement: ${picked.move}` : ''}.`;
    if (hasImage && role === 'animate') return `${want} The first frame already fixes the framing and light, so let the look set only the camera movement and pacing.`;
    return `${want} Build the camera and light on this look, filling in the other parts from CAMERA AND LIGHT, and show each by what it does to the picture. Camera or light the theme names still win. Every take keeps this look and varies within it.`;
  }
  if (hasImage && role === 'recreate') return `Name the image's own shot size, camera angle, lens feel, focus, light sources with their direction, exposure and composition, in precise terms from CAMERA AND LIGHT${moves}.`;
  if (hasImage && role === 'animate') return 'The first frame already fixes the framing, lens and light: keep them. Decide the camera movement, and for every new shot after a cut, its shot size and angle.';
  if (hasImage && role === 'character') return 'Decide the viewpoint (shot size, angle, which way the character faces) and the light of the setting, as CAMERA AND LIGHT and the guide describe.';
  return `Name this theme's feeling to yourself (not in the prompt), then pick the combination in CAMERA AND LIGHT that fits it, or build your own. The prompt names one shot size, one camera angle, one lens, one focus, a key light and a second light with their sources, one contrast or exposure word, one composition technique${moves}, each shown by what it does to the picture. Keep any the theme${hasImage ? ' or image' : ''} already sets; at a short length, keep at least the shot size, angle and key light.`;
}

export function buildRequestText(model, p, variation) {
  const hasImage = Boolean(p.hasImage);
  const theme = (p.theme || '').trim();
  const isVideo = model.kind === 'video';
  const lines = [`Write a prompt for ${model.name} (${model.kind} model).`, ''];

  lines.push(theme ? `THEME: ${theme}` : `THEME: none given; build the prompt from the attached ${hasImage ? 'image' : 'motion video frames'}.`);
  if (hasImage) lines.push('', `IMAGE${p.video ? ' (the first attached image)' : ''}: ${imageInstructions(p.imageRole, Boolean(theme), isVideo)}`);
  if (p.video?.sheetDataUrl) lines.push('', `MOTION VIDEO: ${motionInstructions(p.video, hasImage ? 2 : 1)}`);
  else if (p.video) lines.push('', 'MOTION VIDEO: the generator receives a motion video that you cannot see, and copies its movement. Describe the movement the theme asks for in the motion part the guide describes; if the theme says nothing about it, name the motion simply ("a person dancing").');
  if (hasImage && p.sourcePrompt) {
    lines.push(
      '',
      'PREVIOUS STEP: the attached image was rendered from the prompt below. Use it to name the same people, wardrobe, objects and setting with consistent wording. Follow the image role above and this model\'s guide; do not copy the prompt.',
      `<<<\n${p.sourcePrompt}\n>>>`,
    );
  }

  lines.push('', 'OUTPUT SETTINGS');
  if (p.aspectRatio) {
    const o = orientation(p.aspectRatio);
    lines.push(`- Aspect ratio: ${p.aspectRatio}${o ? ` (${o})` : ''}`);
  }
  if (p.resolution) lines.push(`- Resolution: ${p.resolution}`);
  if (isVideo && p.duration) lines.push(`- Clip duration: ${p.duration}; pace the action to fit it`);
  else if (p.video?.seconds) lines.push(`- Clip duration: as long as the motion video (about ${Math.round(p.video.seconds)} s)`);
  const guide = model.lengthGuide?.[p.length];
  lines.push(`- Prompt length: ${p.length}${guide ? ` (${guide})` : ''}`);

  if (variation && variation.index > 0 && variation.previous.length) {
    const kind = hasImage && ['recreate', 'animate', 'character'].includes(p.imageRole) ? p.imageRole : 'reference';
    const dirs = VARIATION_DIRECTIONS[kind];
    const direction = dirs[(variation.index - 1) % dirs.length];
    lines.push(
      '',
      `VARIATION ${variation.index + 1} OF ${variation.count}. These prompts were already written for this same request${variation.previous.length > RECENT_TAKES ? ` (the latest ${RECENT_TAKES})` : ''}:`,
      // A big batch would flood a small context: the latest few are enough to steer away from.
      ...variation.previous.slice(-RECENT_TAKES).map((t, i, list) => `<<< ${variation.previous.length - list.length + i + 1}\n${t}\n>>>`),
      `Write a clearly different take with ${direction}, while staying faithful to the ${hasImage ? 'theme and image' : 'theme'} and the model guide. Do not reuse their sentences.`,
    );
  }

  // Small models weigh the end most: the camera choices, then the length target.
  lines.push('', `CAMERA AND LIGHT: ${cameraInstructions(p.imageRole, hasImage, isVideo, p.look)}`);
  lines.push('', `Write the prompt now${guide ? `, staying within ${guide.replace(/^≈\s*/, '')}` : ''}. Output only the prompt.`);
  return lines.join('\n');
}

// images: the input image's data URL, and/or the motion video's contact sheet (params.video.sheetDataUrl), in that order.
function userMessage(text, images) {
  if (!images.length) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      ...images.map(url => ({ type: 'image_url', image_url: { url } })),
      { type: 'text', text },
    ],
  };
}

const imagesFor = (params, imageDataUrl) => [imageDataUrl, params.video?.sheetDataUrl].filter(Boolean);

export function buildGenerateMessages(masterPrompt, model, params, imageDataUrl, variation) {
  return [
    { role: 'system', content: buildSystemPrompt(masterPrompt, model) },
    userMessage(buildRequestText(model, { ...params, hasImage: Boolean(imageDataUrl) }, variation), imagesFor(params, imageDataUrl)),
  ];
}

export function buildRefineMessages(masterPrompt, model, params, imageDataUrl, currentPrompt, instruction) {
  return [
    { role: 'system', content: buildSystemPrompt(masterPrompt, model) },
    userMessage(buildRequestText(model, { ...params, hasImage: Boolean(imageDataUrl) }), imagesFor(params, imageDataUrl)),
    { role: 'assistant', content: currentPrompt },
    {
      role: 'user',
      content: `Revise the prompt above. Requested change: "${instruction}"\n\nApply the change fully, keep everything else that still fits, and keep following the ${model.name} guide. Keep the length target (${model.lengthGuide?.[params.length] || params.length}) unless the change is about length. Output ONLY the complete revised prompt.`,
    },
  ];
}

export const GUIDE_TEMPLATE = `## What this model is
- (1–3 lines: what it generates and what it's best at)

## Prompt structure
- (order of elements, prose vs. tags, special syntax)

## Vocabulary that works
- (camera, lens, lighting, texture, motion terms)

## Avoid
- (words or patterns the model misreads)

## Using an attached image
- Reference: ...
- Recreate: ...
- Animate / first frame (video only): ...

## Aspect ratio & length
- ...`;

export function buildDraftGuideMessages(name, kind, docs) {
  return [
    {
      role: 'system',
      content: `You write prompting guides that another AI assistant follows when it writes prompts for an image or video generation model. Turn the documentation you are given into a clear, imperative, well-structured markdown guide of about 400–900 words, using only what the documentation supports. Do not invent syntax or features. Output only the guide, using this outline:\n\n${GUIDE_TEMPLATE}`,
    },
    {
      role: 'user',
      content: `Target model: ${name} (${kind} generation model)\n\nDocumentation and notes:\n"""\n${docs}\n"""\n\nWrite the guide now.`,
    },
  ];
}

// Strip the wrappers small models like to add despite instructions.
export function cleanPrompt(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```[\w-]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  s = s.replace(/^(?:sure[,!.]?\s*)?(?:here(?:'|’)?s|here is)\b[^\n]*?:\s*\n+/i, '');
  s = s.replace(/^\**\s*(?:final\s+|revised\s+)?prompt\s*\**\s*:\s*\**\s*/i, '');
  const q = s.match(/^(["“])([\s\S]*)(["”])$/);
  if (q && !/["“”]/.test(q[2])) s = q[2].trim();
  return s;
}
