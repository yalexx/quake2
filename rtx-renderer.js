// GPL-2.0-or-later. Raster extensions for the shipped Qwasm2 GLES3 shaders.
// No WASM edits, global WebGL prototype patches, geometry changes, or ray tracing.
(() => {
  'use strict';
  const canvas = document.getElementById('canvas');
  const panel = document.getElementById('render-settings');
  const toggle = document.getElementById('rtx-toggle');
  const quality = document.getElementById('rtx-quality');
  const status = document.getElementById('rtx-status');
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('quake2-raster-look') || '{}'); } catch (_) { /* opaque iframe */ }
  const params = new URLSearchParams(location.hash.slice(1));
  let enabled = params.has('rtx') ? params.get('rtx') !== 'off' : saved.enabled !== false;
  let preset = params.get('quality') || saved.quality || 'performance';
  if (!['performance', 'high'].includes(preset)) preset = 'performance';
  const report = { version: 'raster-2', worldShaders: 0, postShaders: 0, modelShaders: 0, skyShaders: 0,
    matchedTextures: 0, materials: {}, failures: [], postDraws: 0, worldDraws: 0, modelDraws: 0, skyDraws: 0,
    uiDraws: 0, fboSkips: 0,
    supported: false };
  let gl, current, textureUnit = 0, dirty = true, sceneDirty = false, composite = null;
  let worldThisFrame = false, skyPending = true;
  const textures = new WeakMap(), programs = new Map(), shaders = new WeakMap(), bound = [];
  // Per material: specular strength, roughness, fixture emission, relief scale.
  // The albedo relief is inferred from the texture's own luminance; a rougher
  // surface keeps more of it and a polished one flattens it. Nothing here adds
  // geometry, a normal map, a shadow or a new light.
  const profile = {
    metal: [0.86, 0.40, 0, 1.00], rust: [0.30, 0.70, 0, 1.10], tech: [0.56, 0.46, 0, 1.00],
    lamp: [0.30, 0.26, 1, 0.30], glass: [0.72, 0.16, 0, 0.45], stone: [0.06, 0.90, 0, 1.20],
    crate: [0.10, 0.82, 0, 0.95], wood: [0.05, 0.92, 0, 1.00], organic: [0.08, 0.78, 0, 0.85],
    sign: [0.10, 0.60, 0, 0.70], flat: [0, 1, 0, 0.50], water: [0.65, 0.20, 0, 0.60],
    sky: [0, 1, 0, 0]
  };
  const MATTE = [0.16, 0.72, 0, 0.90];
  // Weapon and monster skins are not in the wall-texture catalog, so they get
  // one restrained sheen rather than a guessed material.
  const MODEL = [0.45, 0.42, 0, 0.80];
  function update() {
    dirty = true;
    toggle.checked = enabled;
    quality.value = preset;
    quality.disabled = !enabled;
    status.textContent = report.failures.length ? 'Original renderer · effect unavailable' :
      !report.supported ? 'Requires the GLES3 renderer' : enabled ? 'Raster lighting · no ray tracing' : 'Original lighting';
    try { localStorage.setItem('quake2-raster-look', JSON.stringify({ enabled, quality: preset })); } catch (_) { /* optional persistence */ }
  }
  function mode() { return enabled && report.supported && !report.failures.length ? (preset === 'high' ? 2 : 1) : 0; }
  toggle.addEventListener('change', () => { enabled = toggle.checked; update(); });
  quality.addEventListener('change', () => { preset = quality.value; update(); });
  // Keep game keyboard handlers from seeing controls, without stealing gameplay keys.
  panel.addEventListener('keydown', event => event.stopPropagation());
  panel.addEventListener('keyup', event => event.stopPropagation());
  for (const type of ['mousedown','mouseup','click']) panel.addEventListener(type, event => event.stopPropagation());
  document.addEventListener('pointerlockchange', () => { panel.hidden = document.pointerLockElement === canvas; });
  window.quake2RTX = {
    set(on, level = preset) { enabled = !!on; preset = level === 'high' ? 'high' : 'performance'; update(); return this.status(); },
    status() { return { ...report, enabled: mode() > 0, quality: preset, mode: mode(),
      programs: Array.from(programs.values()).map(p=>p.kind) }; }
  };
  update();

  // -------------------------------------------------------------------------
  // World surfaces. The engine hands us the sampled albedo and the baked
  // lightmap (which already contains the dynamic lights), so everything below
  // redistributes that existing energy: it adds no shadow, light or geometry.
  // -------------------------------------------------------------------------
  const worldFunctions = `
uniform float q2RTX;
uniform vec4 q2Material; // specular strength, roughness, fixture emission, relief
in vec3 q2ViewDirection;
float q2Luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 q2Surface(vec3 albedo, vec3 illumination) {
  vec3 n = normalize(passNormal);
  vec3 v = normalize(q2ViewDirection);
  float h = q2Luma(albedo);
  // Surface gradient in world space, from real world/UV derivatives. Height is
  // inferred from albedo, not a supplied normal map or geometric displacement.
  vec3 dp1 = dFdx(passWorldCoord), dp2 = dFdy(passWorldCoord);
  vec3 r1 = cross(dp2, n), r2 = cross(n, dp1);
  float det = dot(dp1, r1);
  vec3 gradient = (r1 * dFdx(h) + r2 * dFdy(h)) / max(abs(det), 0.0001) * sign(det);
  float relief = 0.50 + 0.85 * q2Material.w;
  n = normalize(n - clamp(gradient * relief, vec3(-0.20), vec3(0.20)));
  vec3 l = normalize(vec3(-0.35, -0.45, 0.82));
  float roughness = clamp(q2Material.y + (0.5-h)*0.22, 0.16, 1.0);
  // Two lobes: a tight dielectric glint plus a broad, rougher sheen. The mix is
  // what makes rough metal read as metal instead of as a flat bright wash.
  vec3 halfVector = normalize(l+v);
  float nDotH = max(dot(n, halfVector), 0.0);
  float tight = pow(nDotH, mix(96.0, 7.0, roughness));
  float broad = pow(nDotH, mix(28.0, 3.0, roughness));
  float spec = mix(tight, broad, roughness * 0.55);
  float fresnel = 0.10 + 0.90 * pow(1.0-max(dot(n,v),0.0), 5.0);
  float light = clamp(q2Luma(illumination), 0.0, 1.6);
  // Quake's world up is +Z, so a normal's Z component separates the cool sky
  // side of a surface from the warm floor-bounce side. This is a hemisphere
  // term from the existing baked light energy, not new light or a shadow.
  float up = clamp(n.z * 0.5 + 0.5, 0.0, 1.0);
  vec3 ambientTint = mix(vec3(0.98,0.91,0.85), vec3(0.80,0.88,1.03), up);
  // Art-directed broad key reflection, bounded by existing baked light energy.
  // The lightmaps contain no incident direction or environment reflections.
  vec3 lit = albedo * illumination * (0.87 + 0.21*max(dot(n,l),0.0));
  lit *= ambientTint * (1.0 + 0.10*(up-0.5));
  vec3 tint = mix(vec3(0.80,0.88,1.0), max(albedo,vec3(0.3)), 0.35);
  lit += tint * q2Material.x * light * (spec*1.10 + fresnel*0.20);
  // Actual engine dynamic lights contribute view-dependent highlights too.
  if (q2RTX > 1.5 && passLightFlags != 0u) {
    for (uint i=0u; i<numDynLights; ++i) {
      if ((passLightFlags & (1u << i)) == 0u) continue;
      vec3 d = dynLights[i].lightOrigin-passWorldCoord;
      float attenuation = max(0.0,dynLights[i].lightColor.a-length(d)-52.0)/256.0;
      vec3 hd = normalize(normalize(d)+v);
      float highlight = mix(pow(max(dot(n,hd),0.0),mix(96.0,7.0,roughness)),
                            pow(max(dot(n,hd),0.0),mix(28.0,3.0,roughness)), roughness*0.55);
      lit += dynLights[i].lightColor.rgb * attenuation * highlight * q2Material.x * 0.7;
    }
  }
  // Fixtures burn from their own bright pixels. High quality pushes the core
  // harder and lets the composite bloom carry it further; nothing casts light.
  float emitter = q2Material.z * smoothstep(0.45,0.86,h/max(intensity,0.01));
  vec3 emitterColor = max(albedo, vec3(0.55)) * (q2RTX > 1.5 ? 3.1 : 2.5);
  lit = mix(lit, max(lit, emitterColor), emitter);
  // Aerial perspective: distant surfaces lose a little contrast into a haze
  // tinted by their own baked light, so depth reads and far walls separate.
  // Near geometry is untouched; High carries about three times Performance's
  // haze, which is part of what makes the two presets read differently.
  float viewDistance = length(q2ViewDirection);
  float haze = smoothstep(620.0, 2500.0, viewDistance) * (q2RTX > 1.5 ? 0.30 : 0.10);
  vec3 hazeColor = vec3(0.055,0.070,0.095) + illumination * 0.30;
  lit = mix(lit, hazeColor, haze);
  // Gentle highlight shoulder before the LDR framebuffer clips; no black crush.
  return lit / (vec3(1.0) + max(lit-vec3(0.75),vec3(0.0))*0.45);
}
`;
  // -------------------------------------------------------------------------
  // The composite. It grades the finished scene before the engine draws the
  // HUD, so text and menus stay pixel-crisp and unbloomed.
  // -------------------------------------------------------------------------
  const postFunctions = `
uniform float q2RTX;
vec3 q2Bright(vec2 uv, float threshold) {
  vec3 c = texture(tex,clamp(uv,vec2(0.001),vec2(0.999))).rgb;
  return c * smoothstep(threshold,threshold+0.26,max(c.r,max(c.g,c.b)));
}
vec3 q2Finish(vec3 c, vec2 uv) {
  vec2 px = 1.0/vec2(textureSize(tex,0));
  vec3 glow = vec3(0.0);
  if (q2RTX > 1.5) {
    // High: a wide twelve-tap halo for lamps plus a tight six-tap core, so the
    // fixture itself stays hot while its spill reaches further than one disc.
    // HUD is drawn after this pass and is not bloomed.
    for (int i=0; i<12; ++i) {
      float a = float(i)*2.39996323;
      vec2 offset = vec2(cos(a),sin(a))*sqrt((float(i)+0.5)/12.0)*16.0*px;
      glow += q2Bright(uv+offset,0.58);
    }
    glow /= 12.0;
    for (int i=0; i<6; ++i) {
      float a = float(i)*2.39996323 + 0.7;
      vec2 offset = vec2(cos(a),sin(a))*sqrt((float(i)+0.5)/6.0)*4.0*px;
      glow += q2Bright(uv+offset,0.66)*0.5;
    }
    glow /= 1.5;
  } else {
    // Performance: two horizontal taps, the cheap fallback measured to hold the
    // frame budget on this device.
    glow = (q2Bright(uv+vec2(5,0)*px,0.68)+q2Bright(uv-vec2(5,0)*px,0.68))*0.5;
  }
  float y = dot(c,vec3(0.2126,0.7152,0.0722));
  // Cool shadow / warm light split, with a small lifted toe for dark corners.
  c *= mix(vec3(0.86,0.97,1.12),vec3(1.08,1.03,0.94),smoothstep(0.10,0.85,y));
  c = mix(vec3(y),c,1.12);
  c = c*0.98 + vec3(0.012,0.015,0.02)*(1.0-smoothstep(0.0,0.30,y));
  // High gains a very light corner falloff (no more than 6% at the corners) to
  // pull the eye to the centre; Performance leaves the frame flat.
  if (q2RTX > 1.5) {
    vec2 q = uv-0.5;
    c *= mix(0.94,1.0,clamp(1.0-dot(q,q)*1.1,0.0,1.0));
  }
  c = clamp(c + glow*0.24*(1.0-c),0.0,1.0);
  // Half-level dither: the grade and lifted toe otherwise band in dark
  // corridors and across a large sky on an 8-bit framebuffer.
  float q2noise = fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(0.06711056,0.00583715))));
  float dither = (q2noise-0.5)/255.0;
  return clamp(c+dither,0.0,1.0);
}
`;
  // -------------------------------------------------------------------------
  // The demo's sky is drawn by the engine as a flat two-dimensional fill (its
  // skybox files never load in this build), so a gradient has to be added to
  // that fill rather than to a lit 3D surface. The gradient is screen-vertical
  // and derived from the fill's own colour: it adds no texture and no light.
  // -------------------------------------------------------------------------
  const skyFunctions = `
uniform float q2RTX;
uniform float q2Sky;
uniform vec2 q2SkyViewport;
vec3 q2SkyTint(vec3 col) {
  if (q2RTX < 0.5 || q2Sky < 0.5) return col;
  float h = clamp(gl_FragCoord.y * q2SkyViewport.y, 0.0, 1.0);
  float zenith = smoothstep(0.30, 1.0, h);
  float horizon = 1.0 - smoothstep(0.0, 0.55, h);
  // Deeper, cooler overhead; a touch warmer and brighter at the horizon.
  col *= mix(1.16, 0.82, zenith);
  col += vec3(0.020, 0.026, 0.044) * zenith;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(l), 0.12 * zenith);
  col += vec3(0.018, 0.010, 0.0) * horizon * 0.6;
  return max(col, vec3(0.0));
}
`;
  // -------------------------------------------------------------------------
  // Textured models and the view weapon. The engine lights them by one vertex
  // colour, so they read flat; the world space normal and eye position below
  // let a small key-shape and a cool rim give them volume and a metal sheen.
  // -------------------------------------------------------------------------
  const modelFunctions = `
uniform float q2RTX;
uniform vec4 q2Material;
in vec3 q2ModelNormal;
in vec3 q2ModelPos;
in vec3 q2ModelEye;
vec3 q2ModelShade(vec3 rgb) {
  if (q2RTX < 0.5) return rgb;
  vec3 n = normalize(q2ModelNormal);
  vec3 v = normalize(q2ModelEye - q2ModelPos);
  vec3 key = normalize(vec3(-0.35, -0.45, 0.82));
  float lambert = max(dot(n, key), 0.0);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 halfVector = normalize(key + v);
  float spec = pow(max(dot(n, halfVector), 0.0), mix(72.0, 8.0, q2Material.y));
  vec3 sheen = mix(vec3(0.78,0.87,1.0), max(rgb, vec3(0.25)), 0.35);
  rgb *= 0.90 + 0.12 * lambert;
  rgb += sheen * (rim * 0.14 + spec * 0.22) * q2Material.x;
  return rgb;
}
`;
  function transform(source, type) {
    if (type === gl.VERTEX_SHADER && source.includes('passWorldCoord = worldCoord.xyz;') && source.includes('passNormal')) {
      source = source.replace('void main()', 'out vec3 q2ViewDirection;\nvoid main()');
      return { kind: 'vertex', source: source.replace('passWorldCoord = worldCoord.xyz;',
        'passWorldCoord = worldCoord.xyz; vec4 q2Eye = inverse(transProjView)*vec4(0.0,0.0,-1.0,1.0); q2ViewDirection = q2Eye.xyz/q2Eye.w-worldCoord.xyz;') };
    }
    if (type === gl.FRAGMENT_SHADER && source.includes('outColor = lmTex*texel;') && source.includes('passWorldCoord')) {
      return { kind: 'world', source: source.replace('void main()', worldFunctions+'\nvoid main()')
        .replace('outColor = lmTex*texel;', 'outColor = lmTex*texel; if (q2RTX > 0.5) outColor.rgb = q2Surface(texel.rgb,lmTex.rgb);') };
    }
    if (type === gl.FRAGMENT_SHADER && source.includes('uniform vec4 v_blend;') && source.includes('outColor = res;')) {
      const uv = source.includes('vec2 uv =') ? 'uv' : 'passTexCoord';
      return { kind: 'post', source: source.replace('void main()', postFunctions+'\nvoid main()')
        .replace('res.rgb = v_blend.a', `if (q2RTX > 0.5) res.rgb = q2Finish(res.rgb,${uv}); res.rgb = v_blend.a`) };
    }
    if (type === gl.FRAGMENT_SHADER && source.includes('vec3 col = color.rgb * intensity2D;')) {
      return { kind: 'sky', source: source.replace('void main()', skyFunctions+'\nvoid main()')
        .replace('vec3 col = color.rgb * intensity2D;', 'vec3 col = q2SkyTint(color.rgb * intensity2D);') };
    }
    if (type === gl.VERTEX_SHADER && source.includes('passColor = vertColor*overbrightbits;') && source.includes('void main()')) {
      return { kind: 'modelVertex', source: source.replace('void main()', 'out vec3 q2ModelNormal;\nout vec3 q2ModelPos;\nout vec3 q2ModelEye;\nvoid main()')
        .replace('passColor = vertColor*overbrightbits;',
          'passColor = vertColor*overbrightbits; vec4 q2World = transModel*vec4(position, 1.0); q2ModelNormal = normalize((transModel*vec4(normal, 0.0)).xyz); q2ModelPos = q2World.xyz; vec4 q2Eye = inverse(transProjView)*vec4(0.0,0.0,-1.0,1.0); q2ModelEye = q2Eye.xyz/q2Eye.w;') };
    }
    if (type === gl.FRAGMENT_SHADER && source.includes('texel *= min(vec4(1.5), passColor);')) {
      return { kind: 'model', source: source.replace('void main()', modelFunctions+'\nvoid main()')
        .replace('texel *= min(vec4(1.5), passColor);', 'texel *= min(vec4(1.5), passColor); texel.rgb = q2ModelShade(texel.rgb);') };
    }
    return { kind: 'original', source };
  }
  function fail(message) { report.failures.push(message); console.warn('RTX-style fallback:',message); update(); }
  const originalGetContext = canvas.getContext.bind(canvas);
  canvas.getContext = function (type, options) {
    const ctx = originalGetContext(type, options);
    if (ctx && type === 'webgl2' && ctx !== gl) install(ctx);
    return ctx;
  };
  function install(ctx) {
    gl = ctx;
    const native = {};
    for (const name of ['shaderSource','compileShader','linkProgram','useProgram','activeTexture','bindTexture','texImage2D','drawElements','drawArrays','deleteProgram','clear']) native[name] = gl[name].bind(gl);
    gl.shaderSource = (shader, source) => {
      const patch = transform(source,gl.getShaderParameter(shader,gl.SHADER_TYPE));
      shaders.set(shader,{ ...patch, original: source });
      native.shaderSource(shader,patch.source);
    };
    gl.compileShader = shader => {
      native.compileShader(shader);
      const patch = shaders.get(shader);
      if (patch && patch.kind !== 'original' && !gl.getShaderParameter(shader,gl.COMPILE_STATUS)) {
        fail(gl.getShaderInfoLog(shader));
        native.shaderSource(shader,patch.original); native.compileShader(shader);
      }
    };
    gl.linkProgram = program => {
      native.linkProgram(program);
      if (!gl.getProgramParameter(program,gl.LINK_STATUS)) {
        fail(gl.getProgramInfoLog(program));
        for (const shader of gl.getAttachedShaders(program)) {
          const patch = shaders.get(shader);
          if (patch) { native.shaderSource(shader,patch.original); native.compileShader(shader); }
        }
        native.linkProgram(program);
      }
      const modeLocation = gl.getUniformLocation(program,'q2RTX');
      const materialLocation = gl.getUniformLocation(program,'q2Material');
      const skyLocation = gl.getUniformLocation(program,'q2Sky');
      const skyViewportLocation = gl.getUniformLocation(program,'q2SkyViewport');
      const originals = gl.getAttachedShaders(program).map(shader => shaders.get(shader)?.original || '');
      const is2D = originals.some(source => /uniform\s+uni2D\b/.test(source));
      const isModel = originals.some(source => source.includes('texel *= min(vec4(1.5), passColor);'));
      const kind = skyLocation ? 'sky' : isModel && materialLocation ? 'model' :
        materialLocation ? 'world' : modeLocation ? 'post' : is2D ? 'ui' : 'original';
      programs.set(program,{ kind, modeLocation, materialLocation, skyLocation, skyViewportLocation,
        lastMode: -1, lastTexture: null, lastSky: -1 });
      if (kind === 'world') report.worldShaders++;
      if (kind === 'post') report.postShaders++;
      if (kind === 'model') report.modelShaders++;
      if (kind === 'sky') report.skyShaders++;
      report.supported = report.worldShaders > 0 && report.postShaders > 0;
      update();
    };
    gl.deleteProgram = program => { programs.delete(program); native.deleteProgram(program); };
    gl.useProgram = program => { current = programs.get(program); native.useProgram(program); dirty = true; };
    gl.clear = (...args) => { sceneDirty = false; worldThisFrame = false; skyPending = true; return native.clear(...args); };
    gl.activeTexture = unit => { textureUnit = unit-gl.TEXTURE0; native.activeTexture(unit); };
    gl.bindTexture = (target, texture) => { if (target === gl.TEXTURE_2D) { bound[textureUnit] = texture; dirty = true; } native.bindTexture(target,texture); };
    gl.texImage2D = function (...args) {
      native.texImage2D(...args);
      const [target,level,,width,height,,format,type,pixels,offset=0] = args;
      if (target !== gl.TEXTURE_2D || level !== 0 || format !== gl.RGBA || type !== gl.UNSIGNED_BYTE || !ArrayBuffer.isView(pixels)) return;
      const bytes = new Uint8Array(pixels.buffer,pixels.byteOffset+offset*pixels.BYTES_PER_ELEMENT);
      if (bytes.length < width*height*4) return;
      let hash = 2166136261;
      for (let i=0;i<64;i++) { const p=Math.floor(i*(width*height-1)/63)*4; for(let c=0;c<3;c++) hash=Math.imul(hash^bytes[p+c],16777619); }
      const material = window.quake2MaterialCatalog[`${width}x${height}:${hash>>>0}`];
      if (material && bound[textureUnit]) {
        textures.set(bound[textureUnit],profile[material[1]] || MATTE);
        report.matchedTextures++; report.materials[material[1]]=(report.materials[material[1]]||0)+1;
      }
    };
    function uniforms() {
      if (current?.kind === 'ui') {
        report.uiDraws++;
        if (sceneDirty) {
          sceneDirty = false;
          if (mode()) {
            if (gl.getParameter(gl.FRAMEBUFFER_BINDING)) report.fboSkips++;
            else finishScene();
          }
        }
      }
      if (!current || !current.modeLocation) return;
      const value = mode();
      if (current.lastMode !== value) { gl.uniform1f(current.modeLocation,value); current.lastMode=value; }
      if (current.materialLocation && (dirty || current.lastTexture !== bound[0])) {
        const fallback = current.kind === 'model' ? MODEL : MATTE;
        gl.uniform4fv(current.materialLocation,textures.get(bound[0]) || fallback);
        current.lastTexture=bound[0];
      }
      if (current.kind === 'sky') {
        // Only the engine's flat sky fill is tinted: the first flat fill after
        // the world in a frame. A solid HUD rectangle never is.
        const sky = value > 0 && worldThisFrame && skyPending ? 1 : 0;
        if (sky) skyPending = false;
        if (current.lastSky !== sky) { gl.uniform1f(current.skyLocation,sky); current.lastSky=sky; }
        if (current.skyViewportLocation) gl.uniform2f(current.skyViewportLocation,1/gl.drawingBufferWidth,1/gl.drawingBufferHeight);
      }
      dirty=false;
      if (current.kind==='post') { report.postDraws++; sceneDirty=false; }
      else if (current.kind==='sky') { report.skyDraws++; }
      else if (current.kind==='model') { report.modelDraws++; sceneDirty=true; }
      else if (current.kind==='world') { report.worldDraws++; sceneDirty=true; worldThisFrame=true; }
    }
    gl.drawElements = (...args) => { uniforms(); return native.drawElements(...args); };
    gl.drawArrays = (...args) => { uniforms(); return native.drawArrays(...args); };
    // Upstream only uses its scene FBO underwater. On land, copy the finished
    // default framebuffer at the first 2D draw, composite, then restore every
    // touched GL binding/state so the engine's state cache and HUD stay valid.
    function finishScene() {
      const old = { program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
        active: gl.getParameter(gl.ACTIVE_TEXTURE), viewport: gl.getParameter(gl.VIEWPORT),
        mask: gl.getParameter(gl.COLOR_WRITEMASK), depthMask: gl.getParameter(gl.DEPTH_WRITEMASK) };
      const caps = [gl.DEPTH_TEST,gl.BLEND,gl.CULL_FACE,gl.SCISSOR_TEST,gl.STENCIL_TEST];
      const states = caps.map(cap => gl.isEnabled(cap));
      native.activeTexture(gl.TEXTURE0);
      const oldTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
      const oldSampler = gl.getParameter(gl.SAMPLER_BINDING);
      try {
        // The engine's sampler can require mipmaps; our one-level scene copy
        // must use its own non-mipmapped filtering.
        gl.bindSampler(0,null);
        if (!composite) {
          const program = gl.createProgram();
          const vs = '#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0,1);}';
          const fs = '#version 300 es\nprecision highp float;\nuniform sampler2D tex;out vec4 outColor;\n'+postFunctions+
            '\nvoid main(){vec2 uv=gl_FragCoord.xy/vec2(textureSize(tex,0));vec3 c=texture(tex,uv).rgb;outColor=vec4(q2Finish(c,uv),1);}';
          for (const [type,source] of [[gl.VERTEX_SHADER,vs],[gl.FRAGMENT_SHADER,fs]]) {
            const shader = gl.createShader(type); native.shaderSource(shader,source); native.compileShader(shader);
            if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
            gl.attachShader(program,shader); gl.deleteShader(shader);
          }
          native.linkProgram(program);
          if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
          composite = { program, vao: gl.createVertexArray(), texture: gl.createTexture(), width: 0, height: 0,
            mode: gl.getUniformLocation(program,'q2RTX') };
          native.bindTexture(gl.TEXTURE_2D,composite.texture);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        }
        const width=gl.drawingBufferWidth,height=gl.drawingBufferHeight;
        native.bindTexture(gl.TEXTURE_2D,composite.texture);
        if (composite.width!==width || composite.height!==height) {
          const alpha = gl.getContextAttributes().alpha;
          native.texImage2D(gl.TEXTURE_2D,0,alpha?gl.RGBA8:gl.RGB8,width,height,0,alpha?gl.RGBA:gl.RGB,gl.UNSIGNED_BYTE,null);
          composite.width=width; composite.height=height;
        }
        gl.copyTexSubImage2D(gl.TEXTURE_2D,0,0,0,0,0,width,height);
        caps.forEach(cap=>gl.disable(cap)); gl.colorMask(true,true,true,true); gl.depthMask(false);
        gl.viewport(0,0,width,height); gl.bindVertexArray(composite.vao);
        native.useProgram(composite.program); gl.uniform1f(composite.mode,mode());
        native.drawArrays(gl.TRIANGLES,0,3); report.postDraws++;
      } catch (error) { fail(String(error)); }
      finally {
        native.useProgram(old.program); gl.bindVertexArray(old.vao); gl.viewport(...old.viewport);
        gl.colorMask(...old.mask); gl.depthMask(old.depthMask);
        caps.forEach((cap,i)=>states[i]?gl.enable(cap):gl.disable(cap));
        native.bindTexture(gl.TEXTURE_2D,oldTexture); native.activeTexture(old.active);
        gl.bindSampler(0,oldSampler);
      }
    }
    canvas.addEventListener('webglcontextlost', () => fail('WebGL context lost; reload to restore rendering.'), { once: true });
  }
})();
