const t = THREE;
let camera, scene, renderer, points, connections;
let pixR = window.devicePixelRatio ? window.devicePixelRatio : 1;
let lastConnectionUpdate = 0; // Track when we last updated connections
let nextConnectionUpdateTime = 0; // Next scheduled update time
const SMALL_BATCH_INTERVAL = 1.0; // Check for small batch updates every second
const CONNECTION_REFRESH_RATE = 0.05; // Only update 5% at a time for smoother transitions
const INITIAL_CONNECTIONS = 300; // Number of initial connections to create
const MAX_TOTAL_CONNECTIONS = 600; // Maximum allowed connections at any time
const TARGET_CONNECTIONS = 400; // Target number of active connections
const FADE_IN_DURATION = 0.75; // How long it takes for new connections to fade in (seconds)
const FADE_OUT_DURATION = 1.5; // How long it takes for old connections to fade out (seconds)
let initialSetupDone = false;
let connectionStats = {
    created: 0,
    active: 0,
    fadingIn: 0,
    fadingOut: 0,
    total: 0
};

const NUM_POINTS = 50000; // Suitable number of main points
const NUM_CONNECTED_POINTS = 500; // Subset of points that will have connections
const MAX_CONNECTIONS_PER_POINT = 4; // Maximum number of connections per point
const CONNECTION_THRESHOLD = 2; // Maximum distance for connections
const PERCENTAGE_ANIMATED = 0.5; // 20% of points will move in/out

// Connection states - we'll use this to track which connections are active, fading in, or fading out
let connectionStates = {
    active: [], // Fully visible connections
    fadingIn: [], // New connections that are becoming visible
    fadingOut: [], // Old connections that are disappearing
    pendingRemoval: [] // Connections ready to be removed
};

// HEX to normalized RGB helper
function hexToRgbNorm(hex) {
    hex = typeof hex === 'string' ? hex.replace(/^#/, '') : hex.toString(16).padStart(6, '0');
    if (hex.length === 3) hex = hex.split('').map(x => x + x).join('');
    const num = parseInt(hex, 16);
    return {
        r: ((num >> 16) & 255) / 255,
        g: ((num >> 8) & 255) / 255,
        b: (num & 255) / 255
    };
}

// Color and appearance configuration (all HEX)
const CONFIG = {
    backgroundColor: 0x000000,      // white
    centerColor: 0x0f766e,          // dark blue (for core dots)
    outerColor: 0x14b8a6,           // teal (for outer dots)
    useLineGradient: false,         // use flat color for lines
    lineColorFlat: 0x000000         // dark gray for lines
};

function randomGalaxyPoint() {
    // Use inverse square distribution for density concentration at center
    // This creates higher density in center, lower at edges
    let distance = Math.pow(Math.random(), 1.5) * 4.0;
    
    // Some points are scattered further out (sparse outer shell)
    if (Math.random() > 0.95) {
        distance = 4.0 + Math.random() * 4.0;
    }
    
    // Use spherical coordinates for full 3D distribution
    // Uniform distribution on a sphere
    let theta = Math.random() * Math.PI * 2;    // Longitude: 0 to 2π
    let phi = Math.acos(2 * Math.random() - 1); // Latitude: 0 to π
    
    // Convert to cartesian coordinates
    let x = distance * Math.sin(phi) * Math.cos(theta);
    let y = distance * Math.sin(phi) * Math.sin(theta);
    let z = distance * Math.cos(phi);
    
    return [x, y, z];
}

window.onload = () => {
    setupScene();
    resize();
    render();
    window.addEventListener('resize', resize);
};

function setupScene() {
    camera = new t.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 12;

    scene = new t.Scene();
    scene.background = new t.Color(CONFIG.backgroundColor);

    renderer = new t.WebGLRenderer({antialias: true});
    renderer.setPixelRatio(pixR);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    // Generate points using the galaxy distribution
    const positions = new Float32Array(NUM_POINTS * 3);
    const colors = new Float32Array(NUM_POINTS * 3);
    const animatedFlags = new Float32Array(NUM_POINTS); // To mark which points will animate
    
    const centerColor = hexToRgbNorm(CONFIG.centerColor);
    const outerColor = hexToRgbNorm(CONFIG.outerColor);
    
    // Create point positions
    for (let i = 0; i < NUM_POINTS; i++) {
        const [x, y, z] = randomGalaxyPoint();
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
        
        // Distance from center for color gradient
        const dist = Math.sqrt(x*x + y*y + z*z);
        const distRatio = Math.min(dist / 6.0, 1.0); // Normalize distance for color mixing
        
        // Mix colors based on distance from center
        colors[i * 3] = centerColor.r * (1-distRatio) + outerColor.r * distRatio;      // R
        colors[i * 3 + 1] = centerColor.g * (1-distRatio) + outerColor.g * distRatio;  // G
        colors[i * 3 + 2] = centerColor.b * (1-distRatio) + outerColor.b * distRatio;  // B
        
        // Randomly select points to be animated (20%)
        animatedFlags[i] = Math.random() < PERCENTAGE_ANIMATED ? 1.0 : 0.0;
    }
    
    const geometry = new t.BufferGeometry();
    geometry.setAttribute('position', new t.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new t.BufferAttribute(colors, 3));
    geometry.setAttribute('animated', new t.BufferAttribute(animatedFlags, 1)); // Store animated flag
    
    // Store original positions for animation
    geometry.userData = {
        originalPositions: positions.slice()
    };

    // Basic point material with size attenuation and vertex colors
    const material = new t.PointsMaterial({ 
        vertexColors: true,
        size: 0.03, 
        sizeAttenuation: true,
        transparent: true,
        opacity: 1.0,
        blending: t.AdditiveBlending
    });
    
    points = new t.Points(geometry, material);
    scene.add(points);
    
    // Create connections between points
    createInitialConnections(positions);
}

function createInitialConnections(positions) {
    createConnections(positions, 1.0, INITIAL_CONNECTIONS);
    initialSetupDone = true;
}

function createConnections(positions, replacementPercentage = 1.0, explicitConnectionCount = null) {
    // If replacing all connections (initial setup), clear any existing ones
    if (replacementPercentage >= 1.0 && connections && connections.lines) {
        scene.remove(connections.lines);
        connections = null;
    }
    
    // Create a line geometry to hold all connections
    const lineGeometry = new t.BufferGeometry();
    const lineMaterial = new t.LineBasicMaterial({
        color: 0xffffff, // fallback, not used if vertexColors is true
        transparent: true,
        opacity: 1.0,
        blending: t.AdditiveBlending,
        vertexColors: true,
        linewidth: 1
    });
    
    const linePositions = [];
    const lineColors = [];
    const lineOpacities = [];
    
    // Calculate how many hub connections to create
    // Each hub connects 1 center point to 3 outer points (4 points total, 3 lines)
    const numHubsToCreate = explicitConnectionCount || 
                           Math.floor((NUM_CONNECTED_POINTS / 4) * replacementPercentage);
    
    // For each hub, find one central point and three outer points to connect
    for (let i = 0; i < numHubsToCreate; i++) {
        // Select a random point to be the central hub
        const hubIndex = Math.floor(Math.random() * NUM_POINTS);
        const hubX = positions[hubIndex * 3];
        const hubY = positions[hubIndex * 3 + 1];
        const hubZ = positions[hubIndex * 3 + 2];
        
        // Create a virtual hub point slightly offset from the actual point
        // This gives the effect of a small invisible connector node
        const hubOffset = 0.05; // Small offset to create virtual hub point
        const virtualHubX = hubX + (Math.random() * 2 - 1) * hubOffset;
        const virtualHubY = hubY + (Math.random() * 2 - 1) * hubOffset;
        const virtualHubZ = hubZ + (Math.random() * 2 - 1) * hubOffset;
        
        // Find potential nearby points to connect to the hub
        const potentialNeighbors = [];
        
        // Check a random subset of points to find neighbors
        for (let j = 0; j < 50; j++) {
            const otherIndex = Math.floor(Math.random() * NUM_POINTS);
            if (otherIndex === hubIndex) continue;
            
            const x = positions[otherIndex * 3];
            const y = positions[otherIndex * 3 + 1];
            const z = positions[otherIndex * 3 + 2];
            
            const dist = Math.sqrt(
                Math.pow(x - hubX, 2) + 
                Math.pow(y - hubY, 2) + 
                Math.pow(z - hubZ, 2)
            );
            
            if (dist < CONNECTION_THRESHOLD) {
                potentialNeighbors.push({
                    index: otherIndex,
                    dist: dist,
                    position: [x, y, z]
                });
            }
        }
        
        // Sort by distance and take the closest three neighbors
        potentialNeighbors.sort((a, b) => a.dist - b.dist);
        
        // If we have at least 3 neighbors, form a hub connection
        if (potentialNeighbors.length >= 3) {
            // Create a hub with three spokes
            const hub = { x: virtualHubX, y: virtualHubY, z: virtualHubZ };
            const spoke1 = { 
                x: potentialNeighbors[0].position[0], 
                y: potentialNeighbors[0].position[1], 
                z: potentialNeighbors[0].position[2] 
            };
            const spoke2 = { 
                x: potentialNeighbors[1].position[0], 
                y: potentialNeighbors[1].position[1], 
                z: potentialNeighbors[1].position[2] 
            };
            const spoke3 = { 
                x: potentialNeighbors[2].position[0], 
                y: potentialNeighbors[2].position[1], 
                z: potentialNeighbors[2].position[2] 
            };
            
            // Create the hub-and-spoke connections (3 lines from hub to each spoke)
            // Line 1: hub to spoke1
            linePositions.push(hub.x, hub.y, hub.z);
            linePositions.push(spoke1.x, spoke1.y, spoke1.z);
            
            // Line 2: hub to spoke2
            linePositions.push(hub.x, hub.y, hub.z);
            linePositions.push(spoke2.x, spoke2.y, spoke2.z);
            
            // Line 3: hub to spoke3
            linePositions.push(hub.x, hub.y, hub.z);
            linePositions.push(spoke3.x, spoke3.y, spoke3.z);
            
            // Create colors for the hub connectors
            if (CONFIG.useLineGradient) {
                // Original gradient logic
                const hubDist = Math.sqrt(hubX*hubX + hubY*hubY + hubZ*hubZ);
                const ratio = Math.min(hubDist / 6.0, 1.0);
                const red = 0.1 + ratio * 0.7;
                const green = 0.7 - ratio * 0.5;
                const blue = 0.5 + ratio * 0.3;
                for (let j = 0; j < 3; j++) {
                    const r = red + (j * 0.05);
                    const g = green - (j * 0.03);
                    const b = blue + (j * 0.02);
                    lineColors.push(r, g, b); // Hub end
                    lineColors.push(r*0.8, g*0.8, b*0.8); // Spoke end (slightly darker)
                }
            } else {
                // Flat color from config (convert HEX to normalized RGB)
                const base = hexToRgbNorm(CONFIG.lineColorFlat);
                for (let j = 0; j < 3; j++) {
                    lineColors.push(base.r, base.g, base.b);
                    lineColors.push(base.r * 0.8, base.g * 0.8, base.b * 0.8);
                }
            }
            
            // Initial opacity for all three spokes
            const initialOpacity = replacementPercentage >= 1.0 ? 0.5 : 0.01;
            lineOpacities.push(initialOpacity, initialOpacity, initialOpacity);
        }
    }
    
    // If we have connections to show
    if (linePositions.length > 0) {
        // Create the line geometry
        const linePositionsArray = new Float32Array(linePositions);
        const lineColorsArray = new Float32Array(lineColors);
        
        lineGeometry.setAttribute('position', new t.BufferAttribute(linePositionsArray, 3));
        lineGeometry.setAttribute('color', new t.BufferAttribute(lineColorsArray, 3));
        
        // Store the original positions for animation updates
        lineGeometry.userData = {
            originalPositions: linePositionsArray.slice(),
            hubsCount: linePositions.length / 18 // Each hub uses 18 values (3 lines × 2 points × 3 components)
        };
        
        const newConnections = {
            lines: new t.LineSegments(lineGeometry, lineMaterial),
            opacities: lineOpacities,
            state: replacementPercentage >= 1.0 ? 'active' : 'fadingIn',
            startTime: performance.now() * 0.001, // Track when these connections were created
            hubsCount: lineOpacities.length / 3 // Each hub has 3 spokes with opacity values
        };
        
        // For full replacement, just set connections
        if (replacementPercentage >= 1.0) {
            connections = newConnections;
            connectionStates = {
                active: [connections],
                fadingIn: [],
                fadingOut: [],
                pendingRemoval: []
            };
        } 
        // For partial replacement, add to our connection states
        else {
            if (!connections) {
                connections = newConnections;
                connectionStates.active.push(connections);
            } else {
                connectionStates.fadingIn.push(newConnections);
            }
            
            // Add the new connections to the scene
            scene.add(newConnections.lines);
        }
        
        // Add the main connections object to the scene if it's the first time
        if (replacementPercentage >= 1.0) {
            scene.add(connections.lines);
        }
    }
}

function updateConnections(tNow) {
    // Remove any connections pending removal
    connectionStates.pendingRemoval.forEach(conn => {
        if (conn.lines && conn.lines.parent) {
            scene.remove(conn.lines);
        }
    });
    connectionStates.pendingRemoval = [];
    
    // Process fading in connections
    for (let i = 0; i < connectionStates.fadingIn.length; i++) {
        const conn = connectionStates.fadingIn[i];
        const elapsed = tNow - conn.startTime;
        
        // Fade in over FADE_IN_DURATION seconds
        if (elapsed > FADE_IN_DURATION) {
            // Move to active
            connectionStates.active.push(conn);
            connectionStates.fadingIn.splice(i, 1);
            i--; // Adjust index since we removed an item
        } else {
            // Update opacity based on elapsed time
            const progress = elapsed / FADE_IN_DURATION; // 0 to 1
            const lineColors = conn.lines.geometry.attributes.color;
            
            for (let j = 0; j < conn.opacities.length; j++) {
                const baseIndex = j * 6; // 2 vertices per line, 3 color components per vertex
                
                // Fade from 0 to full opacity
                const opacity = 0.6 * progress;
                
                // Update all color components 
                for (let k = 0; k < 6; k++) {
                    lineColors.array[baseIndex + k] *= 0.9; // Decay slightly
                    lineColors.array[baseIndex + k] += 0.1 * opacity; // Blend toward target opacity
                }
            }
            
            lineColors.needsUpdate = true;
        }
    }
    
    // Process fading out connections
    for (let i = 0; i < connectionStates.fadingOut.length; i++) {
        const conn = connectionStates.fadingOut[i];
        const elapsed = tNow - conn.startTime;
        
        // Fade out over FADE_OUT_DURATION seconds
        if (elapsed > FADE_OUT_DURATION) {
            // Move to pending removal
            connectionStates.pendingRemoval.push(conn);
            connectionStates.fadingOut.splice(i, 1);
            i--; // Adjust index since we removed an item
        } else {
            // Use easeOutCubic for fade-out (smoother at the end)
            // This starts faster and ends slower for a gentler fade-out
            const progress = elapsed / FADE_OUT_DURATION; // 0 to 1
            const easedProgress = 1 - Math.pow(1 - progress, 3);
            const fadeOutFactor = 1.0 - easedProgress; // 1 to 0, with easing
            
            const lineColors = conn.lines.geometry.attributes.color;
            
            for (let j = 0; j < conn.opacities.length; j++) {
                const baseIndex = j * 6; // 2 vertices per line, 3 color components per vertex
                
                // For each color component
                for (let k = 0; k < 6; k++) {
                    // Apply a more gradual fade-out
                    // Start from current value and slowly fade to zero
                    lineColors.array[baseIndex + k] = lineColors.array[baseIndex + k] * 0.95 * fadeOutFactor;
                }
            }
            
            // If very close to invisible, make fully invisible to avoid lingering artifacts
            if (fadeOutFactor < 0.1) {
                conn.lines.visible = false;
            }
            
            lineColors.needsUpdate = true;
        }
    }
    
    // Animate active connections
    connectionStates.active.forEach(conn => {
        const lineColors = conn.lines.geometry.attributes.color;
        
        // Skip if no opacities are defined
        if (!conn.opacities || conn.opacities.length === 0) return;
        
        for (let i = 0; i < conn.opacities.length; i++) {
            // Subtle pulsing for active connections
            const opacity = 0.5 + 0.2 * Math.sin(tNow * 2 + i * 0.1);
            const baseIndex = i * 6; // 2 vertices per line, 3 color components per vertex
            
            for (let j = 0; j < 6; j++) {
                // Just subtle changes for active connections
                lineColors.array[baseIndex + j] = lineColors.array[baseIndex + j] * 0.95 + 0.05 * opacity;
            }
        }
        
        lineColors.needsUpdate = true;
    });
    
    // Update connection statistics
    connectionStats = {
        active: connectionStates.active.reduce((sum, conn) => sum + (conn.hubsCount || 0), 0),
        fadingIn: connectionStates.fadingIn.reduce((sum, conn) => sum + (conn.hubsCount || 0), 0),
        fadingOut: connectionStates.fadingOut.reduce((sum, conn) => sum + (conn.hubsCount || 0), 0),
        total: 0
    };
    connectionStats.total = connectionStats.active + connectionStats.fadingIn + connectionStats.fadingOut;
}

function render() {
    const tNow = performance.now() * 0.001;
    
    // Animate points - make selected percentage move in/out
    if (points && points.geometry) {
        const positions = points.geometry.attributes.position.array;
        const originalPositions = points.geometry.userData.originalPositions;
        const animatedFlags = points.geometry.attributes.animated.array;
        
        for (let i = 0; i < NUM_POINTS; i++) {
            if (animatedFlags[i] > 0) {
                // Get original position (vector from center)
                const x = originalPositions[i * 3];
                const y = originalPositions[i * 3 + 1];
                const z = originalPositions[i * 3 + 2];
                
                // Calculate distance from center
                const dist = Math.sqrt(x*x + y*y + z*z);
                
                // Skip points too close to center to avoid division by zero
                if (dist < 0.1) continue;
                
                // Different frequencies and phases for variety 
                const phase = i * 0.0001;
                const frequency = 0.5 + 0.5 * (i % 5) * 0.1; // Varied frequency
                
                // Scale factor oscillates between 0.8 and 1.2 based on sine wave
                const scale = 0.9 + 0.2 * Math.sin(tNow * frequency + phase);
                
                // Scale the position vector
                positions[i * 3] = x * scale;
                positions[i * 3 + 1] = y * scale; 
                positions[i * 3 + 2] = z * scale;
            }
        }
        
        points.geometry.attributes.position.needsUpdate = true;
    }
    
    // Slowly rotate everything
    points.rotation.y += 0.0015;
    points.rotation.x = Math.sin(tNow * 0.1) * 0.05; // Slight wobble
    
    // Only process connection updates after initial setup
    if (initialSetupDone) {
        // Continuous small batch updates instead of large chunks
        if (tNow >= nextConnectionUpdateTime) {
            // Schedule the next update a small interval away (continuous stream of updates)
            nextConnectionUpdateTime = tNow + SMALL_BATCH_INTERVAL;
            
            // Get the total connections
            const totalCurrentConnections = connectionStats.total;
            
            // If we're above the maximum limit, aggressively fade out more connections
            if (totalCurrentConnections > MAX_TOTAL_CONNECTIONS) {
                const excessConnections = totalCurrentConnections - TARGET_CONNECTIONS;
                const numToRemove = Math.min(connectionStates.active.length, Math.ceil(excessConnections * 0.3)); // Remove 30% of excess each time
                
                for (let i = 0; i < numToRemove && connectionStates.active.length > 0; i++) {
                    const conn = connectionStates.active.shift();
                    conn.state = 'fadingOut';
                    conn.startTime = tNow;
                    connectionStates.fadingOut.push(conn);
                }
            }
            // Normal case - fade out a small percentage regularly
            else if (connectionStates.active.length > 0) {
                // Only mark a small percentage of active connections for fade out
                const numToFadeOut = Math.max(1, Math.ceil(connectionStates.active.length * CONNECTION_REFRESH_RATE));
                
                // Always maintain a minimum number of active connections
                const minActiveToKeep = Math.floor(TARGET_CONNECTIONS * 0.6);
                const actualFadeOut = connectionStates.active.length - numToFadeOut < minActiveToKeep ? 
                                    connectionStates.active.length - minActiveToKeep : 
                                    numToFadeOut;
                
                // Only fade out connections if we're above the minimum threshold                            
                if (actualFadeOut > 0) {
                    // Take the oldest connections to fade out
                    for (let i = 0; i < actualFadeOut; i++) {
                        const conn = connectionStates.active.shift();
                        conn.state = 'fadingOut';
                        conn.startTime = tNow;
                        connectionStates.fadingOut.push(conn);
                    }
                }
            }
            
            // Only create new connections if we're below the maximum and have capacity for fade-in
            if (totalCurrentConnections < MAX_TOTAL_CONNECTIONS && 
                totalCurrentConnections - connectionStats.fadingOut + 20 < TARGET_CONNECTIONS) {
                
                // Calculate how many to create based on current total vs target
                const deficit = TARGET_CONNECTIONS - (totalCurrentConnections - connectionStats.fadingOut);
                const connectionsToAdd = Math.min(
                    20, // Never add more than 20 at once for smooth transitions
                    Math.ceil(deficit * 0.2) // Add 20% of deficit
                );
                
                if (connectionsToAdd > 0 && points && points.geometry) {
                    createConnections(points.geometry.attributes.position.array, 
                                     CONNECTION_REFRESH_RATE, 
                                     connectionsToAdd);
                }
            }
        }
    }
    
    // Update all connections (fading in, active, fading out)
    updateConnections(tNow);
    
    // Rotate all connection groups to match the points
    connectionStates.active.concat(connectionStates.fadingIn, connectionStates.fadingOut)
        .forEach(conn => {
            if (conn && conn.lines) {
                conn.lines.rotation.y = points.rotation.y;
                conn.lines.rotation.x = points.rotation.x;
            }
        });

		renderer.render(scene, camera);
		requestAnimationFrame(render);
	}

function resize() {
		let width = window.innerWidth;
    let height = window.innerHeight;
    camera.aspect = width / height;
		camera.updateProjectionMatrix();
    renderer.setSize(width, height);
}