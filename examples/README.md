# Deployment Examples

This directory contains example configurations for deploying Node-RED with Valkey storage in production environments.

## Architecture Overview

All examples use the **Admin + Worker pattern** recommended for production:

- **Admin Node**: Single instance with persistent storage for Projects (Git repositories)
- **Worker Nodes**: Horizontally scalable instances that load flows from Redis

## Files

### Docker Compose

- **`docker-compose.yml`**: Complete stack with admin, workers, and Valkey

### Kubernetes

- **`k8s/admin-statefulset.yaml`**: Admin node with StatefulSet and persistent volume
- **`k8s/worker-deployment.yaml`**: Worker nodes with horizontal pod autoscaling

## Quick Start

### Docker Compose

1. Install dependencies in your Node-RED image:

```dockerfile
FROM nodered/node-red:latest
RUN npm install node-red-storage-valkey
```

2. Build the image:

```bash
docker build -t my-nodered:latest .
```

3. Update `docker-compose.yml` to use your image

4. Start the stack:

```bash
docker-compose up -d
```

5. Access the admin UI at `http://localhost:1880`

### Kubernetes

1. Deploy Redis/Valkey first (or use existing service):

```bash
kubectl apply -f https://raw.githubusercontent.com/valkey-io/valkey/main/examples/kubernetes/valkey.yaml
```

2. Deploy admin node:

```bash
kubectl apply -f k8s/admin-statefulset.yaml
```

3. Deploy workers:

```bash
kubectl apply -f k8s/worker-deployment.yaml
```

4. Get admin service URL:

```bash
kubectl get svc nodered-admin
```

## Configuration Notes

### Git Configuration

Set Git user info via environment variables (both examples include this):

```yaml
environment:
  - GIT_AUTHOR_NAME=Node-RED Admin
  - GIT_AUTHOR_EMAIL=admin@example.com
  - GIT_COMMITTER_NAME=Node-RED Admin
  - GIT_COMMITTER_EMAIL=admin@example.com
```

This allows Projects to work without manual Git config.

### Authentication

The examples use placeholder credentials. Generate a bcrypt hash:

```bash
node -e "console.log(require('bcryptjs').hashSync('your-password', 8));"
```

Update the `adminAuth` section in the settings.

### Storage Classes

Kubernetes example uses `storageClassName: "standard"`. Adjust to your cluster:

- GKE: `"standard"` or `"standard-rwo"`
- EKS: `"gp2"` or `"gp3"`
- AKS: `"managed-premium"`

### Scaling Workers

**Docker Compose**: Change `replicas` in the deploy section

**Kubernetes**: Scale manually or use HPA (included in worker manifest):

```bash
kubectl scale deployment nodered-worker --replicas=5
```

## Volumes

### Admin Node

Requires persistent storage for:
- `/data/projects/` - Git repositories
- `/data/.config.*.json` - User settings
- `/data/package.json` - Palette packages

### Worker Nodes

Uses ephemeral storage (`emptyDir` in K8s, `/tmp` in Docker). Workers are stateless and load everything from Redis.

## Monitoring

Add health checks to your deployment:

```yaml
livenessProbe:
  httpGet:
    path: /
    port: 1880
  initialDelaySeconds: 30
  periodSeconds: 10
```

## Troubleshooting

### Workers not reloading

Check pub/sub is working:

```bash
# In Redis container
redis-cli MONITOR
# or
valkey-cli MONITOR

# Deploy from admin, you should see:
# PUBLISH nodered:flows:updated <timestamp>
```

### Projects not working

1. Ensure admin node has persistent volume mounted
2. Check Git environment variables are set
3. Verify Projects is enabled in settings: `editorTheme.projects.enabled: true`

### Package sync issues

Check Redis logs for package update messages:

```bash
# Should see after installing palette node on admin:
[ValkeyStorage] Publishing package update: ["node-red-contrib-example"]
```

## Production Checklist

- [ ] Admin node has persistent volume
- [ ] Git credentials configured (env vars or settings UI)
- [ ] Worker nodes have `httpAdminRoot: false`
- [ ] Redis/Valkey has persistent storage
- [ ] Authentication enabled (`adminAuth`)
- [ ] TLS/SSL configured for external access
- [ ] Resource limits set for all pods/containers
- [ ] Monitoring and logging configured
- [ ] Backup strategy for admin volume
- [ ] Git remote configured for Projects (GitHub/GitLab)

## Support

For issues, see the main [README troubleshooting section](../README.md#troubleshooting).
