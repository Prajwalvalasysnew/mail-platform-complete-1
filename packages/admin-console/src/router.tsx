import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { Shell } from './components/Shell';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './pages/Login';
import { FleetPage } from './pages/Fleet';
import { TenantsPage } from './pages/Tenants';
import { DeliverabilityPage } from './pages/Deliverability';
import { PoolsPage } from './pages/Pools';
import { SupportPage } from './pages/Support';
import { AbusePage } from './pages/Abuse';
import { KycPage } from './pages/Kyc';
import { AuditPage } from './pages/Audit';
import { BillingPage } from './pages/Billing';
import { PaymentsPage } from './pages/Payments';
import { SettingsPage } from './pages/Settings';
import { TeamPage } from './pages/Team';
import { DlqPage } from './pages/Dlq';

function Root() {
  const { status } = useAuth();
  // The session lives only in memory; any unauthenticated state (fresh tab,
  // expiry, logout) renders the login screen regardless of URL. No route
  // content, cached authority, or data survives across identities.
  if (status !== 'authenticated') return <LoginPage />;
  return <Shell />;
}

const rootRoute = createRootRoute({ component: Root });

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: FleetPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/tenants', component: TenantsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/deliverability', component: DeliverabilityPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/pools', component: PoolsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/support', component: SupportPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/abuse', component: AbusePage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/kyc', component: KycPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/audit', component: AuditPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/billing', component: BillingPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/payments', component: PaymentsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/team', component: TeamPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/dlq', component: DlqPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '*',
    component: () => (
      <div className="card card-pad empty-state">
        <div className="t">Page not found</div>
      </div>
    ),
  }),
];

const routeTree = rootRoute.addChildren(routes);

export const router = createRouter({
  routeTree,
  defaultPreload: false, // admin routes are never speculatively prefetched
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Outlet re-export keeps the Shell import surface small.
export { Outlet };
