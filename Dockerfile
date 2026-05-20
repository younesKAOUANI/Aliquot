# Multi-stage so the runtime image carries no compiler, no dev dependencies and
# no TypeScript sources. The build stage is cached on package files alone, so a
# source-only change does not re-resolve the dependency tree.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src
# scripts/ is compiled too, not just shipped. Node's type stripping removes
# annotations but does not rewrite ES module syntax, and package.json declares
# commonjs -- so running a .ts file directly in the container fails with
# "Cannot use import statement outside a module". Compiling them means the
# migration runner and the seed are the same kind of artifact as the service.
COPY scripts ./scripts
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
# Migrations ship inside the image next to the compiled runner that applies
# them. The migration runner is a service in compose and would be an init
# container or a job in any real deployment, so the artifact that runs the
# schema change has to be the same artifact that runs the code expecting it --
# otherwise the two drift by a deploy.
#
# dist/migrations rather than /app/migrations because the compiled runner
# resolves them relative to its own location, which keeps the path identical
# whether it runs from source under tsx or compiled in the image.
COPY migrations ./dist/migrations
COPY src/viewer/public ./dist/src/viewer/public

# node:alpine already provides an unprivileged `node` user. Using it rather than
# creating one keeps the uid stable across base image updates.
USER node

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
