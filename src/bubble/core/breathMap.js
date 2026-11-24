import * as THREE from 'three'
import { HASH_NOISE_GLSL } from './shader.js'

// The surface breathing (shader.js, breathing()) evaluated once per frame per
// mesh vertex instead of in every vertex pass (the bubble is drawn twice:
// back and front faces). Positions come from the mesh itself, so the values
// are the ones the vertex shader would compute; stored as float bits.
// Layout: texel (i % width, i / width) holds vertex i: breath, slope t1, slope t2.

const fragmentShader = /* glsl */ `
  precision highp float;
  precision highp int;
  uniform highp sampler2D uPositions;
  uniform float uTime;
  uniform uint uSeed;
  uniform float uBreath;
  layout(location = 0) out highp uvec4 pc_fragColor;
  ${HASH_NOISE_GLSL}
  float breathing(vec3 p, float t, uint seed) {
    return uBreath * (
      0.62 * gnoise(p * 1.3 + vec3(t * 0.21, 0.0, t * 0.05), seed + 200u) +
      0.38 * gnoise(p * 2.2 + vec3(0.0, t * 0.27, t * 0.08), seed + 201u)
    );
  }
  void main() {
    vec3 dir = normalize(texelFetch(uPositions, ivec2(gl_FragCoord.xy), 0).xyz);
    vec3 t1 = normalize(cross(dir, abs(dir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(dir, t1);
    const float EPS = 0.02;
    float b1 = breathing(normalize(dir + t1 * EPS), uTime, uSeed) - breathing(normalize(dir - t1 * EPS), uTime, uSeed);
    float b2 = breathing(normalize(dir + t2 * EPS), uTime, uSeed) - breathing(normalize(dir - t2 * EPS), uTime, uSeed);
    pc_fragColor = floatBitsToUint(vec4(breathing(dir, uTime, uSeed), b1, b2, 0.0));
  }
`

export function createBreathMap(renderer, geometry, width) {
  const position = geometry.attributes.position
  const height = Math.ceil(position.count / width)
  const data = new Float32Array(width * height * 4)
  for (let i = 0; i < position.count; i++) {
    data[i * 4] = position.getX(i)
    data[i * 4 + 1] = position.getY(i)
    data[i * 4 + 2] = position.getZ(i)
  }
  const positions = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType)
  positions.needsUpdate = true
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.UnsignedIntType,
    format: THREE.RGBAIntegerFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  })
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: /* glsl */ `
      in vec3 position;
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader,
    uniforms: {
      uPositions: { value: positions },
      uTime: { value: 0 },
      uSeed: { value: 0 },
      uBreath: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(quad)
  const camera = new THREE.Camera()

  // Fills the map for the material's current time and genome, and points the
  // material at it.
  function update(look) {
    const u = material.uniforms
    u.uTime.value = look.uTime.value
    u.uSeed.value = look.uSeed.value
    u.uBreath.value = look.uBreath.value
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(target)
    renderer.render(scene, camera)
    renderer.setRenderTarget(previous)
    look.uBreathMap.value = target.texture
    look.uBreathWidth.value = width
    look.uBreathBaked.value = true
  }

  function dispose() {
    target.dispose()
    positions.dispose()
    material.dispose()
    quad.geometry.dispose()
  }

  return { update, dispose }
}
