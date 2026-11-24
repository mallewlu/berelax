import * as THREE from 'three'

// The bubble with the lights on (Lab only; Lu, 2026-10-27: the same bubble
// in any surroundings, a light switch in the Lab, nothing on the site).
// "Eşlenik ışık": the dark look's own room, its floor lit exactly to the
// ground's level and its sky adding the light it adds on dark. A film then
// shows  ground + exposure * R * sky  (R * ground + (1 - R) * ground is the
// ground: whatever is invisible on dark stays invisible here, without grey),
// and the one stylisation prints that light as depth of the same colour
// (Oklab: lightness offset * -1.3, colour * 3.6) so it reads on a light
// ground as strongly as on dark. Tried on stills first (bubble-kimlik,
// Vault Ar-Ge 2026-10-27).
//
// The scene is drawn into a linear half-float target (three.js then skips
// tone mapping and the sRGB step), the material's environment intensity at
// 1, and this pass grades it onto the ground.
const GROUND_SRGB = [0xed, 0xe9, 0xe3]
export const LIGHT_GROUND_LOOK = { exposure: 1.8, light: -1.3, chroma: 3.6 }

const toLinear = (v) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function createLightGround(renderer) {
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true })
  const ground = new THREE.Vector3(...GROUND_SRGB.map(toLinear))
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uScene: { value: target.texture },
      uGround: { value: ground },
      uLook: { value: new THREE.Vector3(LIGHT_GROUND_LOOK.exposure, LIGHT_GROUND_LOOK.light, LIGHT_GROUND_LOOK.chroma) },
    },
    vertexShader: /* glsl */ `
      in vec3 position;
      out vec2 vUv;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uScene;
      uniform vec3 uGround;
      uniform vec3 uLook; // exposure, lightness factor, colour factor
      in vec2 vUv;
      out vec4 outColor;
      vec3 oklab(vec3 c) {
        vec3 lms = vec3(
          dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
          dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
          dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
        lms = pow(max(lms, 0.0), vec3(1.0 / 3.0));
        return vec3(
          dot(lms, vec3(0.2104542553, 0.793617785, -0.0040720468)),
          dot(lms, vec3(1.9779984951, -2.428592205, 0.4505937099)),
          dot(lms, vec3(0.0259040371, 0.7827717662, -0.808675766)));
      }
      vec3 fromOklab(vec3 c) {
        vec3 lms = vec3(
          c.x + 0.3963377774 * c.y + 0.2158037573 * c.z,
          c.x - 0.1055613458 * c.y - 0.0638541728 * c.z,
          c.x - 0.0894841775 * c.y - 1.291485548 * c.z);
        lms = lms * lms * lms;
        return vec3(
          dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
          dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
          dot(lms, vec3(-0.0041960863, -0.7034186147, 1.707614701)));
      }
      vec3 toSrgb(vec3 c) {
        return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
      }
      void main() {
        // Unclipped: a bright film's whole lift becomes depth (clipping at
        // white first turned young, vivid bubbles pastel).
        vec3 lit = uGround + uLook.x * max(texture(uScene, vUv).rgb, 0.0);
        vec3 g = oklab(uGround);
        vec3 c = oklab(lit) - g;
        // Soft knees: the sun's glint would otherwise print as a black hole
        // (the brightest point becoming the darkest) or a coloured dot.
        float lift = max(c.x, 0.0);
        float depth = uLook.y * lift / (1.0 + lift / 0.12);
        float colour = uLook.z / (1.0 + lift / 0.25);
        vec3 graded = clamp(fromOklab(g + vec3(depth, colour * c.yz)), 0.0, 1.0);
        outColor = vec4(toSrgb(graded), 1.0);
      }`,
  })
  const quad = new THREE.Mesh(new THREE.BufferGeometry(), material)
  quad.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
  quad.frustumCulled = false
  const quadScene = new THREE.Scene()
  quadScene.add(quad)
  const quadCamera = new THREE.Camera()
  const size = new THREE.Vector2()
  const clear = new THREE.Color()

  return {
    render(scene, camera) {
      renderer.getDrawingBufferSize(size)
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y)
      const previous = renderer.getRenderTarget()
      const alpha = renderer.getClearAlpha()
      renderer.getClearColor(clear)
      renderer.setClearColor(0x000000, 0)
      renderer.setRenderTarget(target)
      renderer.clear()
      renderer.render(scene, camera)
      renderer.setRenderTarget(previous)
      renderer.setClearColor(clear, alpha)
      renderer.render(quadScene, quadCamera)
    },
    dispose() {
      target.dispose()
      material.dispose()
      quad.geometry.dispose()
    },
  }
}
