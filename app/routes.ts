import { type RouteConfig, index, route, layout } from "@react-router/dev/routes";

export default [
  route("login", "routes/login.tsx"),
  route("auth/:token", "routes/auth.tsx"),
  route("logout", "routes/logout.tsx"),
  route("setup", "routes/setup.tsx"),
  route("invite/:token", "routes/invite.tsx"),
  route("no-group", "routes/no-group.tsx"),
  route("avatar/:userId", "routes/avatar.tsx"),
  layout("routes/_app.tsx", [
    index("routes/today.tsx"),
    route("month/:ym?", "routes/month.tsx"),
    route("history", "routes/history.tsx"),
    route("me", "routes/me.tsx"),
    route("group", "routes/group.tsx"),
  ]),
] satisfies RouteConfig;
