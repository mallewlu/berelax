import * as THREE from 'three'
import { FILM_LUT_MAX_NM, FILM_OPTICAL_CALIBRATION } from './filmLut.js'
import { MODE_SLOTS } from './modalTouch.js'

export const MAX_RIPPLES = 8

export const HASH_NOISE_GLSL = /* glsl */ `
  // ---- Integer hash: stable at high frequencies (no sin() precision loss) ----
  uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
  }

  vec3 gradientAt(ivec3 cell, uint salt) {
    uvec3 h = pcg3d(uvec3(cell) + uvec3(salt, salt * 7u + 3u, salt * 13u + 11u));
    return vec3(h) * (2.0 / 4294967295.0) - 1.0;
  }

  float gnoise(vec3 p, uint salt) {
    ivec3 i = ivec3(floor(p));
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n000 = dot(gradientAt(i, salt), f);
    float n100 = dot(gradientAt(i + ivec3(1, 0, 0), salt), f - vec3(1, 0, 0));
    float n010 = dot(gradientAt(i + ivec3(0, 1, 0), salt), f - vec3(0, 1, 0));
    float n110 = dot(gradientAt(i + ivec3(1, 1, 0), salt), f - vec3(1, 1, 0));
    float n001 = dot(gradientAt(i + ivec3(0, 0, 1), salt), f - vec3(0, 0, 1));
    float n101 = dot(gradientAt(i + ivec3(1, 0, 1), salt), f - vec3(1, 0, 1));
    float n011 = dot(gradientAt(i + ivec3(0, 1, 1), salt), f - vec3(0, 1, 1));
    float n111 = dot(gradientAt(i + ivec3(1, 1, 1), salt), f - vec3(1, 1, 1));
    return 1.6 * mix(
      mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
      mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
      u.z
    );
  }
`

// Flow map on the sphere: equirect float texture, filtered by hand so every
// device (including those without float linear filtering) samples it alike.
export const FLOW_SAMPLE_GLSL = /* glsl */ `
  vec2 sphereUv(vec3 d) {
    return vec2(atan(d.x, d.z) / 6.283185307179586 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / 3.141592653589793 + 0.5);
  }
  vec4 flowSample(sampler2D tex, vec2 uv) {
    ivec2 size = textureSize(tex, 0);
    vec2 st = uv * vec2(size) - 0.5;
    vec2 i = floor(st);
    vec2 f = st - i;
    int x0 = ((int(i.x) % size.x) + size.x) % size.x;
    int x1 = (x0 + 1) % size.x;
    int y0 = clamp(int(i.y), 0, size.y - 1);
    int y1 = clamp(int(i.y) + 1, 0, size.y - 1);
    return mix(
      mix(texelFetch(tex, ivec2(x0, y0), 0), texelFetch(tex, ivec2(x1, y0), 0), f.x),
      mix(texelFetch(tex, ivec2(x0, y1), 0), texelFetch(tex, ivec2(x1, y1), 0), f.x),
      f.y
    );
  }
  // Quadratic B-spline (9 taps): smooth (C1) across texel borders, so the flow
  // never shows straight creases at macro zoom. The solver itself stays linear.
  vec4 flowSampleSmooth(sampler2D tex, vec2 uv) {
    ivec2 size = textureSize(tex, 0);
    vec2 st = uv * vec2(size);
    vec2 c = floor(st);
    vec2 f = st - c - 0.5; // -0.5..0.5 around the nearest texel centre
    vec2 w0 = 0.5 * (0.5 - f) * (0.5 - f);
    vec2 w2 = 0.5 * (0.5 + f) * (0.5 + f);
    vec2 w1 = 1.0 - w0 - w2;
    vec4 sum = vec4(0.0);
    for (int y = 0; y < 3; y++) {
      int ty = clamp(int(c.y) - 1 + y, 0, size.y - 1);
      float wy = y == 0 ? w0.y : (y == 1 ? w1.y : w2.y);
      for (int x = 0; x < 3; x++) {
        int tx = ((int(c.x) - 1 + x) % size.x + size.x) % size.x;
        float wx = x == 0 ? w0.x : (x == 1 ? w1.x : w2.x);
        sum += texelFetch(tex, ivec2(tx, ty), 0) * (wx * wy);
      }
    }
    return sum;
  }
`

const NOISE_GLSL = HASH_NOISE_GLSL + /* glsl */ `

  // Touch modes: sum of damped Legendre modes P_2..P_5 around each touch axis.
  // Returns the radial offset f (radius fraction) and its surface gradient.
  uniform vec3 uModeAxis[${MODE_SLOTS}];
  uniform vec4 uModeAmp[${MODE_SLOTS}];

  void modalField(vec3 n, out float f, out vec3 grad) {
    f = 0.0;
    grad = vec3(0.0);
    for (int s = 0; s < ${MODE_SLOTS}; s++) {
      vec4 a = uModeAmp[s];
      if (dot(abs(a), vec4(1.0)) < 1e-6) continue;
      vec3 d = uModeAxis[s];
      float c = dot(n, d);
      float p0 = 1.0, p1 = c, dp1 = 1.0;
      float fs = 0.0, dfs = 0.0;
      for (int l = 1; l < 5; l++) {
        float fl = float(l);
        float pn = ((2.0 * fl + 1.0) * c * p1 - fl * p0) / (fl + 1.0);
        float dpn = (fl + 1.0) * p1 + c * dp1;
        float amp = l == 1 ? a.x : (l == 2 ? a.y : (l == 3 ? a.z : a.w));
        fs += amp * pn;
        dfs += amp * dpn;
        p0 = p1;
        p1 = pn;
        dp1 = dpn;
      }
      f += fs;
      grad += dfs * (d - c * n);
    }
  }

  // Slow, small surface breathing (about 0.5% of the radius): the film is never
  // perfectly still, so reflections and glints shimmer with the bubble.
  uniform float uBreath; // breathing amplitude, radius fraction
  float breathing(vec3 p, float t, uint seed) {
    return uBreath * (
      0.62 * gnoise(p * 1.3 + vec3(t * 0.21, 0.0, t * 0.05), seed + 200u) +
      0.38 * gnoise(p * 2.2 + vec3(0.0, t * 0.27, t * 0.08), seed + 201u)
    );
  }
`

export const zoomVertexShader = /* glsl */ `
  precision highp float;
  precision highp int;
  uniform float uTime;
  uniform uint uSeed;
  uniform vec4 uSquash; // local flow axis, flattening (volume kept)
  out vec3 vLocal;
  out vec3 vBend; // how breathing and touch modes tilt the surface normal
  ${NOISE_GLSL}

  void main() {
    vLocal = position;
    vec3 dir = normalize(position);
    float modal;
    vec3 modalGrad;
    modalField(dir, modal, modalGrad);
    // Both shapes are smooth over the mesh (low orders), so their slopes are
    // found here, per vertex, rather than per pixel: much cheaper on phones.
    vec3 t1 = normalize(cross(dir, abs(dir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(dir, t1);
    const float EPS = 0.02;
    float b1 = breathing(normalize(dir + t1 * EPS), uTime, uSeed) - breathing(normalize(dir - t1 * EPS), uTime, uSeed);
    float b2 = breathing(normalize(dir + t2 * EPS), uTime, uSeed) - breathing(normalize(dir - t2 * EPS), uTime, uSeed);
    vBend = (t1 * b1 + t2 * b2) / (2.0 * EPS) + modalGrad / (1.0 + modal);
    vec3 moved = dir * (1.0 + breathing(dir, uTime, uSeed) + modal);
    // Oncoming air flattens the bubble slightly along the flow.
    moved = moved * (1.0 + 0.5 * uSquash.w) - uSquash.xyz * dot(moved, uSquash.xyz) * (1.5 * uSquash.w);
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(moved, 1.0);
  }
`

export const zoomFragmentShader = /* glsl */ `
  precision highp float;
  precision highp int;

  #define PI 3.141592653589793
  #define MAX_OCTAVES 14
  #define ENV_TILT -0.32
  #define ENVIRONMENT_FLOOR ${FILM_OPTICAL_CALIBRATION.environmentFloor.toFixed(3)}
  #define ENVIRONMENT_RIM_FLOOR ${FILM_OPTICAL_CALIBRATION.environmentRimFloor.toFixed(3)}
  #define BACK_SURFACE_CENTRE ${FILM_OPTICAL_CALIBRATION.backSurfaceCentre.toFixed(3)}
  #define BACK_SURFACE_RIM ${FILM_OPTICAL_CALIBRATION.backSurfaceRim.toFixed(3)}
  #define FILM_LUT_MAX_NM ${FILM_LUT_MAX_NM.toFixed(1)}

  // Fixed irrational rotation between octaves (breaks axis alignment).
  const mat3 OCTAVE_ROTATION = mat3(
     0.00,  0.80,  0.60,
    -0.80,  0.36, -0.48,
    -0.60, -0.48,  0.64
  );

  uniform sampler2D uEnv;
  uniform sampler2D uFilmLut;
  uniform float uEnvIntensity;
  uniform vec3 uCameraPos;
  uniform mat4 modelMatrix;
  uniform float uTime;
  uniform uint uSeed;
  uniform float uDetail;
  uniform float uViewSize;
  uniform mat3 uEnvRotation;              // visible surface height, local units
  uniform sampler2D uFlow;              // x = film thickness nm, yzw = fine-detail offset
  uniform float uGrain;                 // genome: base frequency of fine texture
  uniform float uOctaveDecay;           // genome: how fast finer octaves fade
  uniform float uCrisp;                 // genome: filament edge softness
  uniform vec3 uFibre;                  // genome: preferred filament direction
  uniform vec4 uBlack;                  // genome: onset nm, spot scale, edge, density
  uniform float uEarlyBlack;            // genome: black islands even on thick film
  uniform float uThicknessScale;        // a baby bubble's film is thinner than its parent's
  uniform vec4 uCut;                    // world sphere (centre, radius) hiding the part inside the other bubble
  uniform vec4 uRipple[${MAX_RIPPLES}];   // xyz = local source, w = strength
  uniform float uRippleAge[${MAX_RIPPLES}];
  uniform vec2 uRippleWave;             // genome: speed scale (surface tension), decay scale (viscosity)

  in vec3 vLocal;
  in vec3 vBend;
  layout(location = 0) out highp vec4 pc_fragColor;
  #define gl_FragColor pc_fragColor
  ${NOISE_GLSL}
  ${FLOW_SAMPLE_GLSL}

  // Symmetric sharpening: crisp boundaries between thick and thin film while
  // keeping a zero mean, so adding octaves never shifts the average colour.
  float crisp(float n) {
    return clamp(n / (abs(n) + uCrisp), -1.0, 1.0);
  }

  vec3 filmColour(float thicknessNm, float cosI) {
    vec2 uv = vec2(clamp(thicknessNm / FILM_LUT_MAX_NM, 0.0, 1.0), clamp(cosI, 0.0, 1.0));
    return texture(uFilmLut, uv).rgb;
  }

  // Environment: equirect HDR rendered in Blender (Z-up, camera on -Y), plus
  // one sun that is part of the same sky: the sky brightens toward it, and
  // its mirror images are the glints. One light, one frame of reference.
  const vec3 SUN_DIR = vec3(-0.5, 0.55, 0.67);

  vec3 envRadiance(vec3 d, bool frontSurface, float cosI) {
    // Seen from slightly above the horizon (as photographers shoot), the
    // reflected horizon bends into an arc: the strongest "this is a sphere" cue.
    float c = cos(ENV_TILT), s = sin(ENV_TILT);
    d = vec3(d.x, c * d.y - s * d.z, s * d.y + c * d.z);
    // Viewer motion (gyro / pointer) and slow drift turn the surroundings.
    d = uEnvRotation * d;
    vec3 b = vec3(d.x, -d.z, d.y);
    float u = 0.5 + atan(b.x, b.y) / (2.0 * PI);
    float v = 0.5 + asin(clamp(b.z, -1.0, 1.0)) / PI;
    vec3 env = texture(uEnv, vec2(u, v)).rgb * uEnvIntensity;
    // The dark studio still returns skylight at grazing angles. Keep the
    // centre floor tiny, then raise only the Fresnel rim; a uniform grey floor
    // would lay an opaque-looking veil over the whole sphere.
    float grazing = 1.0 - cosI;
    float lightFloor = mix(ENVIRONMENT_FLOOR, ENVIRONMENT_RIM_FLOOR, grazing * grazing * grazing);
    env = max(env, vec3(lightFloor * uEnvIntensity));

    float facing = max(0.0, dot(d, normalize(SUN_DIR)));
    // Sky glow around the sun: gives the bubble a lit side and a darker side.
    env *= 0.82 + 0.45 * pow(facing, 6.0);
    // Front surface (convex mirror): small, sharp, bright image of the sun.
    // Back surface (concave, seen through the film): larger, dimmer, inverted.
    float glint = frontSurface
      ? pow(facing, 2600.0) * 26.0 + pow(facing, 320.0) * 1.0
      : pow(facing, 140.0) * 1.6 + pow(facing, 30.0) * 0.18;
    return env + vec3(glint);
  }

  // Capillary ripples from a touch: a dispersive wave train (short waves run
  // ahead, long ones trail) that spreads, thins out and dies away. Real film
  // ripples cross a bubble in milliseconds; these are slowed to what an eye
  // can follow calmly: a few broad rings (each point rises and falls at
  // 0.4-1.4 Hz), born softly and fading over a second or so.
  // eta: film thickness wave (-1..1 per unit strength); slope: surface tilt.
  const float RIPPLE_K[3] = float[3](16.0, 11.0, 7.5);      // rad^-1 on the unit sphere
  const float RIPPLE_C[3] = float[3](0.55, 0.42, 0.32);     // rad/s
  const float RIPPLE_TAU[3] = float[3](0.9, 1.2, 1.6);      // s
  const float RIPPLE_A[3] = float[3](0.35, 0.6, 0.55);
  const float RIPPLE_W[3] = float[3](0.35, 0.45, 0.55);     // packet width, rad

  void ripples(vec3 p, out float eta, out vec3 slope) {
    eta = 0.0;
    slope = vec3(0.0);
    for (int i = 0; i < ${MAX_RIPPLES}; i++) {
      float strength = uRipple[i].w;
      if (strength <= 0.0) continue;
      vec3 c = uRipple[i].xyz;
      float t = uRippleAge[i];
      float cs = clamp(dot(p, c), -1.0, 1.0);
      float s = acos(cs); // distance along the film from the source
      vec3 away = p - c * cs;
      float al = length(away);
      vec3 outward = al > 1e-5 ? away / al : vec3(0.0);
      // Energy spreads over a widening ring; a soft start, no sudden pop.
      float spread = strength / sqrt(1.0 + 4.0 * s) * (1.0 - exp(-t / 0.12));
      float tilt = 0.0;
      for (int j = 0; j < 3; j++) {
        float x = s - RIPPLE_C[j] * uRippleWave.x * t;
        float envelope = exp(-x * x / (RIPPLE_W[j] * RIPPLE_W[j])) * exp(-t / (RIPPLE_TAU[j] * uRippleWave.y));
        float phase = RIPPLE_K[j] * x;
        eta += RIPPLE_A[j] * sin(phase) * envelope * spread;
        tilt += RIPPLE_A[j] * RIPPLE_K[j] * cos(phase) * envelope * spread;
      }
      slope += outward * tilt;
    }
  }

  void main() {
    vec3 p = normalize(vLocal);
    float rippleEta;
    vec3 rippleSlope;
    ripples(p, rippleEta, rippleSlope);
    // Film thickness comes from the GPU film simulation (flowMap.js): bands,
    // swirls and everything a finger spread. Fine detail rides a short-memory
    // offset of the same flow.
    vec4 flow = flowSampleSmooth(uFlow, sphereUv(p));
    vec3 fineFilm = normalize(p + flow.yzw);
    float footprint = max(length(fwidth(fineFilm)), 1e-7);
    float thickness = flow.x;
    float filmThickness = flow.x;
    vec3 warp = vec3(
      gnoise(fineFilm * 1.5, uSeed + 1u),
      gnoise(fineFilm * 1.5 + vec3(5.2, 1.3, 0.0), uSeed + 2u),
      gnoise(fineFilm * 1.5 + vec3(0.0, 9.1, 2.7), uSeed + 3u)
    );

    // ---- Detail cascade: only octaves resolvable at this zoom, zero mean ----
    float freq = uGrain;
    float amp = 16.0;
    vec3 dw = fineFilm + warp * 0.35;
    // Filaments lean along the genome's fibre direction (anisotropic texture).
    dw += uFibre * dot(dw, uFibre) * 0.7;
    for (int o = 0; o < MAX_OCTAVES; o++) {
      float cyclesPerPixel = freq * footprint;
      if (cyclesPerPixel > 0.5) break;
      float fade = 1.0 - smoothstep(0.12, 0.45, cyclesPerPixel);
      float n = gnoise(dw * freq, uSeed + 40u + uint(o));
      // Octaves near ~1/12 of the visible height are lifted, so every zoom
      // level shows clear structure instead of only the view-angle tint.
      float scaleRatio = log2((1.0 / freq) / (uViewSize / 12.0));
      float boost = exp(-scaleRatio * scaleRatio * 0.5);
      thickness += crisp(n) * (amp + 30.0 * boost) * fade * uDetail;
      float a = float(o) * 2.39996;
      dw = OCTAVE_ROTATION * dw + vec3(cos(a), sin(a * 1.31), sin(a)) * n * (0.9 / freq);
      freq *= 2.07;
      amp *= uOctaveDecay;
    }

    // ---- Black film: appears where the film has really thinned ----
    float cap = max(smoothstep(uBlack.x, uBlack.x * 0.45, filmThickness), uEarlyBlack * 0.6);
    float threshold = 0.85 - 0.3 * uBlack.w;
    float spots = smoothstep(threshold - uBlack.z, threshold + uBlack.z,
      gnoise((fineFilm + warp * 0.35) * uBlack.y, uSeed + 90u)) * cap;
    thickness = mix(thickness, 8.0, spots);
    // Ripples move film: a few nm of thickness change shift the colours in rings.
    thickness += rippleEta * 40.0;
    thickness = max(4.0, thickness * uThicknessScale);

    // ---- Shading on the true sphere, with the touch slope bending the normal ----
    vec3 nLocal = normalize(p - vBend - rippleSlope * 0.006);
    vec3 n = normalize(mat3(modelMatrix) * nLocal);
    vec3 surfaceW = (modelMatrix * vec4(p, 1.0)).xyz;
    vec3 v = normalize(uCameraPos - surfaceW);
    if (!gl_FrontFacing) n = -n;
    float cosI = clamp(abs(dot(n, v)), 0.0, 1.0);
    vec3 R = filmColour(thickness, cosI);
    if (!gl_FrontFacing) {
      float grazing = 1.0 - cosI;
      float visibility = mix(BACK_SURFACE_CENTRE, BACK_SURFACE_RIM, grazing * grazing);
      R *= visibility;
    }
    vec3 radiance = envRadiance(reflect(-v, n), gl_FrontFacing, cosI);
    float loss = dot(R, vec3(1.0 / 3.0));
    // Tone mapping and sRGB are non-linear, so a premultiplied linear colour
    // cannot be transformed and then blended as premultiplied output. Carry a
    // straight colour through those transforms and let NormalBlending apply
    // the physical film reflectance afterwards. This is what keeps the centre
    // transparent instead of turning a few percent reflection into a planet.
    vec3 reflectedRadiance = radiance * R;
    gl_FragColor = vec4(reflectedRadiance / max(loss, 1e-5), loss);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    // A double bubble: each film is hidden where it lies inside the other.
    if (uCut.w > 0.0 && distance(surfaceW, uCut.xyz) < uCut.w) discard;
  }
`

export function createZoomMaterial(envTexture, filmLut) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: zoomVertexShader,
    fragmentShader: zoomFragmentShader,
    uniforms: {
      uEnv: { value: envTexture },
      uFilmLut: { value: filmLut },
      uEnvIntensity: { value: FILM_OPTICAL_CALIBRATION.environmentIntensity },
      uCameraPos: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uSeed: { value: 23 },
      uDetail: { value: 1 },
      uViewSize: { value: 2.4 },
      uEnvRotation: { value: new THREE.Matrix3() },
      uModeAxis: { value: Array.from({ length: MODE_SLOTS }, () => new THREE.Vector3(0, 0, 1)) },
      uModeAmp: { value: Array.from({ length: MODE_SLOTS }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uFlow: { value: null },
      uBreath: { value: 0.0055 },
      uGrain: { value: 14 },
      uOctaveDecay: { value: 0.88 },
      uCrisp: { value: 0.18 },
      uFibre: { value: new THREE.Vector3(1, 0, 0) },
      uBlack: { value: new THREE.Vector4(150, 46, 0.1, 0.6) },
      uEarlyBlack: { value: 0 },
      uThicknessScale: { value: 1 },
      uCut: { value: new THREE.Vector4(0, 0, 0, 0) },
      uSquash: { value: new THREE.Vector4(0, 1, 0, 0) },
      uRipple: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, 1, 0)) },
      uRippleAge: { value: new Float32Array(MAX_RIPPLES).fill(99) },
      uRippleWave: { value: new THREE.Vector2(1, 1) },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  })
}
