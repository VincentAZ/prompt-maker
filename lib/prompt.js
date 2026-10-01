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

const ROLE_LABELS = { reference: 'reference', recreate: 'recreate', animate: 'animate' };

function orientation(ratio) {
  const m = /^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/.exec(ratio || '');
  if (!m) return '';
  const r = Number(m[1]) / Number(m[2]);
  return r > 1.05 ? 'landscape' : r < 0.95 ? 'portrait/vertical' : 'square';
}

export function buildSystemPrompt(masterPrompt, model) {
  let s = `${masterPrompt.trim()}\n\n# TARGET MODEL: ${model.name} (${model.kind} generation)\n\n${model.instructions.trim() || '(No model-specific guide provided. Use general best practices for this kind of model.)'}`;
  if (model.examples?.length) {
    s += `\n\n# EXAMPLE PROMPTS FOR ${model.name.toUpperCase()}\nMatch their style, structure and level of detail. Never copy their content.\n\n`;
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
};

export function buildRequestText(model, p, variation) {
  const hasImage = Boolean(p.hasImage);
  const theme = (p.theme || '').trim();
  const isVideo = model.kind === 'video';
  const lines = [`Write a prompt for ${model.name} (${model.kind} model).`, ''];

  lines.push(theme ? `THEME: ${theme}` : 'THEME: none given; build the prompt from the attached image.');
  if (hasImage) lines.push('', `IMAGE: ${imageInstructions(p.imageRole, Boolean(theme), isVideo)}`);
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
  const guide = model.lengthGuide?.[p.length];
  lines.push(`- Prompt length: ${p.length}${guide ? ` (${guide})` : ''}`);

  if (variation && variation.index > 0 && variation.previous.length) {
    const kind = hasImage && p.imageRole === 'recreate' ? 'recreate' : hasImage && p.imageRole === 'animate' ? 'animate' : 'reference';
    const dirs = VARIATION_DIRECTIONS[kind];
    const direction = dirs[(variation.index - 1) % dirs.length];
    lines.push(
      '',
      `VARIATION ${variation.index + 1} OF ${variation.count}. These prompts were already written for this same request:`,
      ...variation.previous.map((t, i) => `<<< ${i + 1}\n${t}\n>>>`),
      `Write a clearly different take with ${direction}, while staying faithful to the ${hasImage ? 'theme and image' : 'theme'} and the model guide. Do not reuse their sentences.`,
    );
  }

  // Small models drift long, so restate the length target last, where it weighs most.
  lines.push('', `Write the prompt now${guide ? `, staying within ${guide.replace(/^≈\s*/, '')}` : ''}. Output only the prompt.`);
  return lines.join('\n');
}

function userMessage(text, imageDataUrl) {
  if (!imageDataUrl) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: imageDataUrl } },
      { type: 'text', text },
    ],
  };
}

export function buildGenerateMessages(masterPrompt, model, params, imageDataUrl, variation) {
  return [
    { role: 'system', content: buildSystemPrompt(masterPrompt, model) },
    userMessage(buildRequestText(model, { ...params, hasImage: Boolean(imageDataUrl) }, variation), imageDataUrl),
  ];
}

export function buildRefineMessages(masterPrompt, model, params, imageDataUrl, currentPrompt, instruction) {
  return [
    { role: 'system', content: buildSystemPrompt(masterPrompt, model) },
    userMessage(buildRequestText(model, { ...params, hasImage: Boolean(imageDataUrl) }), imageDataUrl),
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
