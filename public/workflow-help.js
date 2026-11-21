// Instructions follow the workflow's actual inputs. The bundled workflows also have known picture roles.
import { usesPlaceAndPerson } from './picture-roles.js';

export function workflowGuide(flow, model) {
  const { maps, imageSlots = [] } = flow;
  const video = model?.kind === 'video';
  const media = video ? 'video' : 'image';
  const starter = flow.source?.startsWith('starter:') ? flow.source.slice(8).split('/')[0] : '';
  const paired = usesPlaceAndPerson(model, imageSlots);
  const fixed = Boolean(model?.fixedPrompt);
  const orbit = model?.id === 'minimax-h3-orbit';
  const inputs = [];
  const steps = [];
  let purpose = `Make a new ${media} with ${model?.name || 'this workflow'}.`;
  let idea = video ? 'Describe who is in the shot, what happens first and how it ends.' : 'Describe the subject, the setting and the light you want in the finished picture.';
  let example = starter ? model?.guide?.tryThese?.[0] : '';
  let first = '';
  let tip = '';

  if (paired) {
    purpose = 'Put the person from one photo into the place shown in another.';
    first = 'The background to keep. Pick a view with room for the person.';
    idea = 'In Your idea, say where the person goes and what they do. Leave it empty for a natural pose, or choose Surprise me for an idea based on both photos.';
    example = 'Have her sit on the bench on the left, facing the camera.';
    tip = 'If the setting changes too much, check the photo order and turn on Review prompt first. Check that the written take describes your setting before you render.';
  } else if (orbit) {
    purpose = 'Make a looping video that circles a subject frozen in place.';
    first = 'A clear picture with the whole subject in view and space around the edges.';
    idea = 'Leave Your idea empty. This workflow supplies its own camera instructions.';
    tip = 'Watch the loop through once. If the subject gets cut off during the turn, try a wider starting picture.';
  } else if (fixed) {
    idea = 'Leave Your idea empty. This model supplies its own instructions.';
  } else if (maps.video && model?.motionVideo) {
    purpose = 'Make the character in your picture perform the movement from a video.';
    first = 'A clear view of the character who will perform the movement.';
    idea = 'Use Your idea for the setting and camera angle. The movement comes from your clip.';
  } else if (maps.image && model?.characterSheet) {
    purpose = video ? 'Make a video starring the person in your reference photo.' : 'Make another picture of the same person.';
    first = 'A clear photo of the person whose face and build you want to keep.';
    idea = video ? 'Describe the new scene, what the person does and what we hear.' : 'Choose New scene and describe where the person goes, or choose Recreate to keep the original pose, clothing and place. For Recreate, type only the changes you want.';
    tip = 'After writing a take, check Character sheet under your photos. Correct any missing or mistaken features before writing another take.';
  } else if (maps.image && model?.task === 'edit') {
    purpose = 'Change a picture you already have.';
    first = 'The main picture you want to change. This supplies the starting composition.';
    idea = 'In Your idea, name the change, where it belongs and any details you want to keep.';
    example ||= 'Make the jacket dark green and keep the face and background the same.';
    if (starter === 'flux-3-klein-base-edit') tip = 'The first picture sets the output shape. If you turn on Use my own prompt, word for word, describe the whole finished picture including the change.';
    if (starter === 'krea-2-raw-i2i') tip = 'If too much changes, open Picture settings and lower the amount of change. Raise it for a stronger transformation.';
  } else if (maps.image && video && model?.task === 'animate') {
    purpose = 'Bring a still picture to life as the opening frame of a video.';
    first = 'The picture the video should start from.';
    idea = 'Describe what moves from this starting frame, how the camera moves and what we hear.';
  } else if (!maps.image && !maps.video) {
    purpose = video ? 'Make a video from a written scene.' : 'Make a picture from a written idea.';
    if (starter === 'z-image-turbo' || starter === 'minimax-h3-image') idea += ' Put any words that should appear in the picture in quotation marks and say where they go.';
    if (starter === 'flux-3-klein-base') example = 'A blue ceramic cup beside a folded newspaper, photographed in soft morning light.';
  }

  if (starter === 'minimax-h3-image') {
    purpose = 'Make a detailed picture, poster or product layout from your words.';
    tip = 'For fine detail, choose a Recommended size. For a 3:4 portrait, start at 1792 × 2368. If you changed the rendering settings, use 6 steps and CFG 1 for a comparison. Keep the same prompt and seed so you can see what the size changed.';
  }
  if (starter === 'ltx-2-3' || starter === 'ltx-2-3-t2v') tip = 'For a clip with sound, describe what you hear as the action happens. Put any spoken words in quotes.';
  if (starter === 'minimax-h3' || starter === 'minimax-h3-t2v') tip = 'For two shots, describe the first action, say when to cut, then describe the second. Give a spoken line enough time to finish.';
  if (starter === 'minimax-h3-image-edit') tip = 'Refer to each extra picture by its number. Describe where its subject goes in Picture 1 so subjects from different photos stay distinct.';
  if (starter === 'qwen-image-edit') tip = 'If the edit changes too much, name the details to keep, such as the face, lettering or background, and write a fresh take.';
  if (maps.image) {
    const slots = imageSlots.length ? imageSlots : [{ label: video && model?.motionVideo ? 'Character' : 'Starting picture' }];
    for (const [i, slot] of slots.entries()) {
      let detail = slot.hint || 'Add the picture you want this input to use.';
      if (i === 0 && first && (starter || paired || !slot.hint)) detail = first;
      else if (paired && i === 1) detail = 'A clear photo of the person to put in the first photo.';
      else if (starter === 'minimax-h3-ref' && i === 1) detail = 'Another view of the same person to help keep their likeness.';
      else if (starter === 'minimax-h3-ref' && i > 1) detail = 'An additional subject, outfit, object or place. Say how it fits into the scene.';
      else if (starter && i > 0 && model?.task === 'edit') detail = 'Something to bring into the first picture. Say what to use from this photo and where to put it.';
      const last = inputs.at(-1);
      if (starter && i > 1 && slot.optional && last.optional && last.detail === detail && (model?.task === 'edit' || starter === 'minimax-h3-ref')) {
        last.label = `Pictures ${last.start}–${i + 1}`;
      } else {
        inputs.push({ label: `Picture ${i + 1} · ${slot.label || 'Image'}`, optional: i > 0 && !!slot.optional, detail, start: i + 1 });
      }
    }
  }
  if (maps.video) inputs.push({ label: 'Motion video', detail: 'Add a clip showing the movement. Use Trim to choose the part you want to use.' });
  if (maps.audio) inputs.push({ label: 'Spoken line', optional: true, detail: 'Under Says a line, choose a voice and type the exact words for the clip.' });

  if (maps.image || maps.video) steps.push('On Create, add the required inputs in the order shown above. You can use Library for a picture you made earlier.');
  steps.push(idea);
  if (maps.video && flow.background) steps.push('Under Background, choose From your picture or From your video to set which scene stays behind the character.');
  if (maps.duration && video && !maps.video) steps.push('Set Duration to the number of seconds you want for the action.');
  if (maps.size && !maps.image) steps.push('Choose Shape for the framing and Size for the finished result.');
  steps.push(fixed ? `Click Make ${media}. Open Your renders to ${video ? 'play the finished clip' : 'see the finished picture'}.` : `Click Make ${media} to write and render. To read the prompt first, turn on Review prompt first, click Write prompt, then click Render on the take you want. The result appears in Your renders.`);
  if (flow.source?.endsWith('-nvfp4.json')) tip += ' This version requires a Blackwell graphics card.';
  else if (flow.source?.endsWith('-bf16.json')) tip += ' This version needs more graphics memory than the default INT8 workflow.';
  return { purpose, inputs, steps, example, tip: tip.trim() };
}
