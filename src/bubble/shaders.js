import * as THREE from 'three'

export const MAX_BUBBLE_IMPACTS = 4

export const bubbleVertexShader = /* glsl */ `
  precision highp float;

  #define MAX_IMPACTS 4

  uniform float uTime;
  uniform float uMicroWaveStrength;
  uniform float uMicroWaveScale;
  uniform float uMicroWaveSpeed;
  uniform vec4 uPointerImpacts[MAX_IMPACTS];
  uniform float uImpactAges[MAX_IMPACTS];

  varying vec3 vLocalPosition;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vImpactField;

  float microWave(vec3 p) {
    float phase = uTime * uMicroWaveSpeed;
    float a = sin((p.x + p.y * 0.73) * uMicroWaveScale + phase);
    float b = sin((p.z - p.y * 0.51) * uMicroWaveScale * 1.37 - phase * 0.83);
    float c = sin((p.x - p.z * 0.61) * uMicroWaveScale * 0.71 + phase * 1.21);
    return (a + b + c) / 3.0;
  }

  float impactWave(vec3 p, vec3 center, float strength, float age) {
    float distanceFromHit = distance(normalize(p), normalize(center));
    float propagation = age * 1.45;
    float ring = sin((distanceFromHit - propagation) * 34.0);
    float envelope = exp(-20.0 * abs(distanceFromHit - propagation));
    float lifetime = exp(-age * 2.4) * (1.0 - smoothstep(1.8, 2.6, age));
    return ring * envelope * lifetime * strength;
  }

  void main() {
    vec3 localNormal = normalize(normal);
    // Real bubbles hold a near-perfect sphere; keep the idle wobble well under 1%.
    float displacement = microWave(position) * uMicroWaveStrength * 0.45;
    float impactField = 0.0;

    for (int i = 0; i < MAX_IMPACTS; i++) {
      // Branch instead of multiplying by zero: an empty slot holds (0,0,0),
      // and normalize(0) is NaN on Metal-backed GPUs, which would erase the mesh.
      if (abs(uPointerImpacts[i].w) > 0.0001) {
        impactField += impactWave(
          position,
          uPointerImpacts[i].xyz,
          uPointerImpacts[i].w,
          max(0.0, uImpactAges[i])
        );
      }
    }

    displacement += impactField * 0.055;
    vec3 displacedPosition = position + localNormal * displacement;
    vec4 worldPosition = modelMatrix * vec4(displacedPosition, 1.0);

    vLocalPosition = displacedPosition;
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * localNormal);
    vImpactField = impactField;

    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`

export const bubbleFragmentShader = /* glsl */ `
  precision highp float;

  #define MAX_IMPACTS 4
  #define PI 3.141592653589793
  #define FILM_IOR 1.333
  #define SPECTRAL_SAMPLES 8

  uniform float uTime;
  uniform vec3 uCameraPosition;
  uniform float uFilmThickness;
  uniform float uThicknessVariation;
  uniform float uThicknessGradient;
  uniform float uFresnelF0;
  uniform float uLightIntensity;
  uniform float uSoftboxIntensity;
  uniform float uEnvMode;
  uniform float uAmbientIntensity;
  uniform float uMicroWaveScale;
  uniform float uMicroWaveStrength;
  uniform vec4 uPointerImpacts[MAX_IMPACTS];
  uniform float uImpactAges[MAX_IMPACTS];

  varying vec3 vLocalPosition;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vImpactField;

  // Two-interface (air-film-air) Airy reflectance for one wavelength. The pi
  // phase flip at the first interface makes a vanishing film reflect nothing,
  // so the thinnest draining film turns black exactly like a real bubble cap.
  float filmReflectance(float thicknessNm, float cosT, float surfaceR, float wavelengthNm) {
    float s = sin(2.0 * PI * FILM_IOR * thicknessNm * cosT / wavelengthNm);
    s *= s;
    float k = 4.0 * surfaceR / max(1e-4, (1.0 - surfaceR) * (1.0 - surfaceR));
    return k * s / (1.0 + k * s);
  }

  float lobe(float x, float centre, float width) {
    float t = (x - centre) / width;
    return exp(-t * t);
  }

  // Approximate linear-RGB response to a spectral sample; the short red lobe
  // lets thin films read as magenta/violet instead of a plain RGB rainbow.
  vec3 spectralWeight(float wavelengthNm) {
    return vec3(
      lobe(wavelengthNm, 600.0, 42.0) + 0.32 * lobe(wavelengthNm, 445.0, 22.0),
      lobe(wavelengthNm, 550.0, 44.0),
      lobe(wavelengthNm, 455.0, 30.0)
    );
  }

  vec3 thinFilmReflectance(float thicknessNm, float cosI, float surfaceR) {
    float sinT2 = (1.0 - cosI * cosI) / (FILM_IOR * FILM_IOR);
    float cosT = sqrt(max(0.0, 1.0 - sinT2));
    vec3 reflected = vec3(0.0);
    vec3 weightSum = vec3(0.0);
    for (int i = 0; i < SPECTRAL_SAMPLES; i++) {
      float wavelength = 405.0 + float(i) * (290.0 / float(SPECTRAL_SAMPLES - 1));
      vec3 weight = spectralWeight(wavelength);
      reflected += weight * filmReflectance(thicknessNm, cosT, surfaceR, wavelength);
      weightSum += weight;
    }
    return reflected / weightSum;
  }

  // Soft rectangular area light seen along direction r (a large diffuser).
  float softPanel(vec3 r, vec3 centre, vec3 right, vec2 halfSize, float softness) {
    vec3 up = normalize(cross(right, centre));
    float facing = dot(r, centre);
    if (facing <= 0.0) return 0.0;
    vec2 uv = vec2(dot(r, right), dot(r, up)) / facing;
    vec2 edge = 1.0 - smoothstep(halfSize - softness, halfSize, abs(uv));
    return edge.x * edge.y;
  }

  // "Invisible room": a neutral space the viewer never sees directly, only
  // through the film. uEnvMode 0 = horizon, 1 = room, 2 = room + side light.
  vec3 studioRadiance(vec3 r) {
    // Neutral light only: every hue on screen must come from the film itself.
    float ambient = uAmbientIntensity * (0.35 + 0.65 * smoothstep(-0.6, 1.0, r.y));

    // Soft horizon: bright open space above, dim floor below. On a sphere it
    // reads as the curved, inverted horizon seen in outdoor bubble photos.
    float horizon = smoothstep(-0.1, 0.16, r.y);
    float sky = mix(0.05, 0.55 + 0.45 * smoothstep(0.1, 1.0, r.y), horizon);
    // Directions behind the bubble face the same dark backdrop the viewer sees.
    sky *= mix(0.35, 1.0, smoothstep(-0.7, 0.35, r.z));

    float window = 0.0;
    if (uEnvMode > 0.5) {
      window = softPanel(
        r,
        normalize(vec3(-0.42, 0.34, 0.84)),
        normalize(vec3(0.9, 0.0, 0.45)),
        vec2(0.6, 0.46),
        0.5
      );
    }
    float sideLight = 0.0;
    if (uEnvMode > 1.5) {
      sideLight = softPanel(
        r,
        normalize(vec3(0.93, 0.05, -0.36)),
        normalize(vec3(0.36, 0.0, 0.93)),
        vec2(0.06, 0.7),
        0.05
      );
    }
    float glint = pow(max(0.0, dot(r, normalize(vec3(-0.45, 0.52, 0.72)))), 900.0);
    return vec3(
      ambient
      + uSoftboxIntensity * (sky + 7.0 * window + 2.2 * sideLight)
      + uLightIntensity * glint
    );
  }

  float impactHighlight(vec3 p) {
    float result = 0.0;
    for (int i = 0; i < MAX_IMPACTS; i++) {
      if (abs(uPointerImpacts[i].w) > 0.0001) {
        float d = distance(normalize(p), normalize(uPointerImpacts[i].xyz));
        float radius = max(0.0, uImpactAges[i]) * 1.45;
        float ring = exp(-30.0 * abs(d - radius));
        result += ring * exp(-uImpactAges[i] * 2.2) * abs(uPointerImpacts[i].w);
      }
    }
    return clamp(result, 0.0, 1.0);
  }

  void main() {
    vec3 viewDirection = normalize(uCameraPosition - vWorldPosition);
    vec3 normalDirection = normalize(vWorldNormal);
    if (!gl_FrontFacing) normalDirection *= -1.0;

    // A tiny view-dependent perturbation keeps the highlight alive without derivatives/WebGL2.
    vec3 ripple = vec3(
      sin(vWorldPosition.y * uMicroWaveScale * 1.9 + uTime * 0.77),
      sin(vWorldPosition.z * uMicroWaveScale * 1.6 - uTime * 0.61),
      sin(vWorldPosition.x * uMicroWaveScale * 2.1 + uTime * 0.53)
    );
    normalDirection = normalize(normalDirection + ripple * uMicroWaveStrength * 0.48);

    float cosTheta = clamp(abs(dot(normalDirection, viewDirection)), 0.0, 1.0);
    // Unpolarised Fresnel for air->water: Schlick overstates mid-grazing
    // reflectance about 2x, which washed the rim out to white.
    float sinT2 = (1.0 - cosTheta * cosTheta) / (FILM_IOR * FILM_IOR);
    float cosT = sqrt(max(0.0, 1.0 - sinT2));
    float rs = (cosTheta - FILM_IOR * cosT) / (cosTheta + FILM_IOR * cosT);
    float rp = (FILM_IOR * cosTheta - cosT) / (FILM_IOR * cosTheta + cosT);
    float surfaceR = clamp(0.5 * (rs * rs + rp * rp), uFresnelF0, 0.98);

    // Gravity drains the film: thin (gold, then black) at the top, thick
    // banded colour lower down, with slow marangoni-like swirls on top.
    vec3 p = normalize(vLocalPosition);
    float drainage = (1.0 - p.y) * 0.5;
    // Mostly horizontal bands, broken up by turbulence that is strongest in
    // the thin upper cap, as in studio photographs of draining films.
    float turbulence = 1.0 - smoothstep(0.15, 0.6, drainage);
    float warp = sin(p.x * 7.0 + uTime * 0.21) * sin(p.z * 6.0 - uTime * 0.17);
    float swirl =
      sin(p.y * 9.0 + warp * (0.6 + 2.2 * turbulence) + uTime * 0.09) * 0.6 +
      sin((p.x - p.z) * 5.4 - uTime * 0.16) * 0.22 * (0.4 + turbulence) +
      sin(p.y * 21.0 + p.x * 4.0 + uTime * 0.07) * 0.18;
    float touchRing = impactHighlight(vLocalPosition);
    float thickness = uFilmThickness
      + (drainage - 0.5) * uThicknessGradient
      + swirl * uThicknessVariation
      + vImpactField * 60.0
      + touchRing * 90.0;
    thickness = max(4.0, thickness);

    vec3 reflectance = thinFilmReflectance(thickness, cosTheta, surfaceR);
    vec3 reflectedDirection = reflect(-viewDirection, normalDirection);

    // Premultiplied composite: background * (1 - R) + reflected light. The
    // alpha term lets a white page show the darker grazing rim seen in photos.
    float transmissionLoss = dot(reflectance, vec3(1.0 / 3.0));
    gl_FragColor = vec4(studioRadiance(reflectedDirection) * reflectance, transmissionLoss);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

export function createBubbleUniforms() {
  return {
    uTime: { value: 0 },
    uCameraPosition: { value: new THREE.Vector3(0, 0, 3) },
    uFilmThickness: { value: 950 },
    uThicknessVariation: { value: 170 },
    uThicknessGradient: { value: 1100 },
    uFresnelF0: { value: 0.02 },
    uLightIntensity: { value: 40 },
    uSoftboxIntensity: { value: 0.6 },
    uEnvMode: { value: 1 },
    uAmbientIntensity: { value: 0.15 },
    uMicroWaveStrength: { value: 0.018 },
    uMicroWaveScale: { value: 5.5 },
    uMicroWaveSpeed: { value: 0.62 },
    uPointerImpacts: {
      value: Array.from(
        { length: MAX_BUBBLE_IMPACTS },
        () => new THREE.Vector4()
      ),
    },
    uImpactAges: {
      value: new Float32Array(MAX_BUBBLE_IMPACTS).fill(10),
    },
  }
}

export function createBubbleMaterial({ uniforms = {} } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: bubbleVertexShader,
    fragmentShader: bubbleFragmentShader,
    uniforms: {
      ...createBubbleUniforms(),
      ...uniforms,
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  })
}
