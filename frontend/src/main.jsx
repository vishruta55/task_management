import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const roles = [
  { value: 'admin', label: 'Admin' },
  { value: 'manager', label: 'Manager' },
  { value: 'tl', label: 'Team Leader' },
  { value: 'member', label: 'Team Member' },
];

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

function apiUrl(path) {
  return `${API_BASE_URL}/api${path}`;
}

function App() {
  const [csrfToken, setCsrfToken] = useState('');
  const [user, setUser] = useState(null);
  const [data, setData] = useState(null);
  const [view, setView] = useState('dashboard');
  const [previousView, setPreviousView] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  async function api(path, options = {}) {
    const response = await fetch(apiUrl(path), {
      credentials: 'include',
      ...options,
      headers: {
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(csrfToken ? { 'X-CSRFToken': csrfToken } : {}),
        ...(options.headers || {}),
      },
    });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await response.json().catch(() => ({}))
      : {};
    const fallbackError = !contentType.includes('application/json')
      ? await response.text().then((text) => text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)).catch(() => '')
      : '';
    if (!response.ok) {
      const fieldErrors = body.errors
        ? Object.entries(body.errors).flatMap(([field, errors]) => {
            const messages = Array.isArray(errors) ? errors : [errors];
            return messages.map((message) => `${field}: ${message}`);
          })
        : [];
      throw new Error([body.error, ...fieldErrors].filter(Boolean).join(' ') || fallbackError || `Request failed (${response.status}).`);
    }
    return body;
  }

  async function loadBootstrap() {
    const body = await api('/bootstrap/');
    setData(body);
    setUser(body.user);
  }

  useEffect(() => {
    fetch(apiUrl('/session/'), { credentials: 'include' })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Backend returned ${response.status} ${response.statusText}`);
        }
        return response.json();
      })
      .then((body) => {
        setCsrfToken(body.csrfToken);
        setUser(body.user);
        setSessionReady(true);
        if (body.user) {
          loadBootstrap();
        }
      })
      .catch((error) => {
        console.error('Backend connection failed:', error);
        setNotice(`Could not connect to the backend: ${error.message}`);
        setSessionReady(true);
      });
  }, []);

  async function handleLogin(values) {
    setBusy(true);
    try {
      const body = await api('/login/', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      setCsrfToken(body.csrfToken);
      setUser(body.user);
      await loadBootstrap();
      setNotice('');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await api('/logout/', { method: 'POST' });
    setUser(null);
    setData(null);
    setView('dashboard');
    setPreviousView('');
  }

  async function mutate(action, success) {
    setBusy(true);
    try {
      const result = await action();
      try {
        await loadBootstrap();
      } catch (error) {
        throw new Error(`Action completed, but refresh failed: ${error.message}`);
      }
      setNotice(typeof success === 'function' ? success(result) : success);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return <LoginScreen busy={busy} csrfReady={Boolean(csrfToken) && sessionReady} notice={notice} onLogin={handleLogin} />;
  }

  if (!data) {
    return <div className="loading">Loading workspace...</div>;
  }

  function navigate(nextView) {
    if (nextView === view) return;
    setPreviousView(view);
    setView(nextView);
  }

  function goBack() {
    setView(previousView || 'dashboard');
    setPreviousView('');
  }

  const isAdmin = user.isStaff || user.isSuperuser;
  const nav = isAdmin ? [
    ['back', 'Back'],
    ['managerView', 'Manager View'],
    ['tlView', 'Team Leader View'],
    ['memberView', 'Team Member View'],
  ] : [
    ['back', 'Back'],
    ['dashboard', 'Dashboard'],
    ...(user.role === 'manager' ? [['projects', 'Projects'], ['reports', 'Reports']] : []),
    ...(user.role === 'tl' || user.role === 'manager' ? [['tasks', 'Tasks']] : []),
    ...(user.role === 'member' ? [['member', 'My Tasks']] : []),
  ];

  const reviewTasks = data.tasks.filter((task) => task.status === 'submitted');

  return (
    <div>
      <header className="topbar">
        <div className="shell topbarInner">
          <div className="brand">
            <span className="brandMark">TM</span>
            <span>Task Management</span>
          </div>
          <nav className="navTabs">
            {nav.map(([key, label]) => (
              <button key={key} className={view === key ? 'active' : ''} onClick={() => (key === 'back' ? goBack() : navigate(key))}>
                {label}
              </button>
            ))}
          </nav>
          <button className="ghostButton" onClick={handleLogout}>Logout</button>
        </div>
      </header>

      <main className="shell main">
        <section className="pageHead">
          <div>
            <p className="eyebrow">{user.roleLabel}</p>
            <h1>{headingFor(view, user)}</h1>
            <p>Signed in as {user.username}</p>
          </div>
        </section>

        {notice && <div className="notice">{notice}</div>}
        {view === 'dashboard' && <Dashboard data={data} user={user} reviewTasks={reviewTasks} setView={navigate} busy={busy} api={api} mutate={mutate} />}
        {view === 'adminUsers' && <ManageUsersSection data={data} busy={busy} api={api} mutate={mutate} />}
        {view === 'adminGroups' && <CreateGroupSection data={data} busy={busy} api={api} mutate={mutate} />}
        {view === 'managerView' && <ManagerDashboard data={data} setView={navigate} />}
        {view === 'tlView' && <TeamLeaderDashboard data={data} busy={busy} api={api} mutate={mutate} user={user} setView={navigate} />}
        {view === 'tlProjects' && <AssignedProjectsView data={data} busy={busy} api={api} mutate={mutate} />}
        {view === 'memberView' && <TeamMemberDashboard data={data} busy={busy} api={api} mutate={mutate} />}
        {view === 'admin' && <AdminDashboard data={data} setView={navigate} />}
        {view === 'projects' && <ProjectsView data={data} busy={busy} api={api} mutate={mutate} user={user} />}
        {view === 'reports' && <ReportsView data={data} />}
        {view === 'tasks' && (
          user.role === 'tl'
            ? <TeamLeaderDashboard data={data} busy={busy} api={api} mutate={mutate} user={user} setView={navigate} />
            : <TasksView data={data} busy={busy} api={api} mutate={mutate} user={user} />
        )}
        {view === 'member' && <MemberTasks data={data} busy={busy} api={api} mutate={mutate} />}
      </main>
    </div>
  );
}

function headingFor(view, user) {
  if ((user.isStaff || user.isSuperuser) && view === 'dashboard') return 'Admin Dashboard';
  if (view === 'adminUsers') return 'Manage Users';
  if (view === 'adminGroups') return 'Create Group';
  if (view === 'managerView') return 'Manager Dashboard';
  if (view === 'tlView') return 'Team Leader View';
  if (view === 'tlProjects') return 'My Assigned Projects';
  if (view === 'memberView') return 'Team Member View';
  if (view === 'admin') return 'Administration';
  if (view === 'projects') return 'Projects';
  if (view === 'reports') return 'Reports';
  if (view === 'tasks') return 'Team Tasks';
  if (view === 'member') return 'My Tasks';
  if (user.role === 'tl') return 'Team Leader Dashboard';
  if (user.role === 'member') return 'Member Dashboard';
  return 'Manager Dashboard';
}

function LoginScreen({ busy, csrfReady, notice, onLogin }) {
  const [values, setValues] = useState({ role: 'manager', username: '', password: '' });
  const disabled = busy || !csrfReady;
  return (
    <main className="loginPage">
      <form className="loginPanel" onSubmit={(event) => {
        event.preventDefault();
        onLogin(values);
      }}>
        <div className="brand large"><span className="brandMark">TM</span><span>Task Management</span></div>
        <h1>Sign in</h1>
        <div className="roleGrid">
          {roles.map((role) => (
            <label key={role.value} className={values.role === role.value ? 'selected' : ''}>
              <input
                type="radio"
                name="role"
                value={role.value}
                checked={values.role === role.value}
                onChange={(event) => setValues({ ...values, role: event.target.value })}
              />
              {role.label}
            </label>
          ))}
        </div>
        <input placeholder="Username" value={values.username} onChange={(event) => setValues({ ...values, username: event.target.value })} />
        <input placeholder="Password" type="password" value={values.password} onChange={(event) => setValues({ ...values, password: event.target.value })} />
        {notice && <div className="notice danger">{notice}</div>}
        <button className="primaryButton" disabled={disabled}>{busy ? 'Signing in...' : 'Sign in'}</button>
      </form>
    </main>
  );
}

function Dashboard({ data, user, reviewTasks, setView, busy, api, mutate }) {
  if (user.isStaff || user.isSuperuser) {
    return <AdminDashboard data={data} setView={setView} />;
  }

  const pendingProjects = data.stats.pendingProjects ?? Math.max(data.stats.totalProjects - data.stats.completedProjects, 0);
  if (user.role === 'manager') {
    return (
      <div className="statsGrid">
        <Stat label="Total Project" value={data.stats.totalProjects} />
        <Stat label="Completed Project" value={data.stats.completedProjects} />
        <Stat label="Pending Project" value={pendingProjects} />
        <Stat label="Total Task" value={data.stats.totalTasks} />
        <Stat label="Completed Task" value={data.stats.completedTasks} />
      </div>
    );
  }

  if (user.role === 'member') {
    return <TeamMemberDashboard data={data} busy={busy} api={api} mutate={mutate} />;
  }

  const progress = data.stats.totalTasks ? Math.round((data.stats.completedTasks / data.stats.totalTasks) * 100) : 0;
  return (
    <>
      <div className="statsGrid">
        <Stat label="Projects" value={data.stats.totalProjects} />
        {(user.role === 'manager' || user.isSuperuser) && <Stat label="Pending Projects" value={pendingProjects} />}
        <Stat label="Tasks" value={data.stats.totalTasks} />
        <Stat label="Completed Tasks" value={data.stats.completedTasks} />
        <Stat label="Submitted" value={data.stats.submittedTasks} />
        {(user.isStaff || user.isSuperuser) && <Stat label="Users" value={data.stats.totalUsers} />}
        {user.role === 'member' && <Stat label="Progress" value={`${progress}%`} />}
      </div>
      <Panel title="Quick Actions">
        <div className="quickActions">
          {(user.isStaff || user.isSuperuser) && <button className="primaryButton" onClick={() => setView('admin')}>Manage users</button>}
          {(user.role === 'manager' || user.isSuperuser) && <button className="primaryButton" onClick={() => setView('projects')}>Create project</button>}
          {(user.role === 'manager' || user.isSuperuser) && <button onClick={() => setView('reports')}>View reports</button>}
          {user.role === 'tl' && <button className="primaryButton" onClick={() => setView('tlProjects')}>My assigned projects</button>}
          {(user.role === 'tl' || user.role === 'manager' || user.isSuperuser) && <button onClick={() => setView('tasks')}>Review tasks</button>}
          {user.role === 'member' && <button className="primaryButton" onClick={() => setView('member')}>Update my work</button>}
        </div>
      </Panel>
      {(user.role === 'tl' || user.isStaff || user.isSuperuser) && reviewTasks.length > 0 && (
        <div className="notice">
          <strong>{reviewTasks.length} task{reviewTasks.length === 1 ? '' : 's'} waiting for review:</strong> {reviewTasks.map((task) => task.taskName).join(', ')}
        </div>
      )}
      <Panel title="Recent Tasks">
        <TaskTable tasks={data.tasks.slice(0, 6)} compact />
      </Panel>
    </>
  );
}

function AdminDashboard({ data, setView }) {
  return (
    <>
      <div className="statsGrid">
        <Stat label="User" value={data.stats.totalUsers} />
        <Stat label="Manager" value={data.stats.managers} />
        <Stat label="Team Leader" value={data.stats.teamLeaders} />
        <Stat label="Team Member" value={data.stats.members} />
      </div>
      <Panel title="Quick Actions">
        <div className="quickActions">
          <button className="primaryButton" onClick={() => setView('adminUsers')}>Manage users</button>
          <button onClick={() => setView('adminGroups')}>Create group</button>
        </div>
      </Panel>
    </>
  );
}

function ManagerDashboard({ data, setView }) {
  const pendingProjects = data.stats.pendingProjects ?? Math.max(data.stats.totalProjects - data.stats.completedProjects, 0);
  return (
    <div className="statsGrid">
      <Stat label="Total Project" value={data.stats.totalProjects} />
      <Stat label="Completed Project" value={data.stats.completedProjects} />
      <Stat label="Pending Project" value={pendingProjects} />
      <Stat label="Total Task" value={data.stats.totalTasks} />
      <Stat label="Completed Task" value={data.stats.completedTasks} />
    </div>
  );
}

function TeamLeaderDashboard({ data, busy, api, mutate, user, setView }) {
  const reviewTasks = data.tasks.filter((task) => task.status === 'submitted');
  return (
    <>
      <div className="statsGrid">
        <Stat label="Assigned Projects" value={data.stats.totalProjects} />
        <Stat label="Total Tasks" value={data.stats.totalTasks} />
        <Stat label="Waiting Review" value={reviewTasks.length} />
        <Stat label="Completed Tasks" value={data.stats.completedTasks} />
      </div>
      <Panel title="Quick Actions">
        <div className="quickActions">
          <button className="primaryButton" onClick={() => setView('tlProjects')}>My assigned projects</button>
        </div>
      </Panel>
      <TasksView data={data} busy={busy} api={api} mutate={mutate} user={user} />
    </>
  );
}

function AssignedProjectsView({ data, busy, api, mutate }) {
  return (
    <Panel title="My Assigned Projects">
      <table>
        <thead><tr><th>Project</th><th>Deadline</th><th>Status</th><th>Update Status</th></tr></thead>
        <tbody>
          {data.projects.map((project) => (
            <tr key={project.id}>
              <td><strong>{project.name}</strong><span>{project.description}</span></td>
              <td>{project.deadline}</td>
              <td><span className="badge">{project.statusLabel}</span></td>
              <td>
                <select value={project.status} disabled={busy} onChange={(event) => mutate(
                  () => api(`/projects/${project.id}/status/`, { method: 'POST', body: JSON.stringify({ status: event.target.value }) }),
                  'Project status updated.',
                )}>
                  {data.options.projectStatuses.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </td>
            </tr>
          ))}
          {!data.projects.length && (
            <tr><td colSpan="4" className="empty">No projects assigned yet.</td></tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function TeamMemberDashboard({ data, busy, api, mutate }) {
  const progress = data.stats.totalTasks ? Math.round((data.stats.completedTasks / data.stats.totalTasks) * 100) : 0;
  const pendingTasks = data.tasks.filter((task) => task.status === 'pending').length;
  return (
    <>
      <div className="statsGrid">
        <Stat label="Tasks" value={data.stats.totalTasks} />
        <Stat label="Pending Task" value={pendingTasks} />
        <Stat label="Completed Tasks" value={data.stats.completedTasks} />
        <Stat label="Progress" value={`${progress}%`} />
      </div>
      <RecentMemberTasks tasks={data.tasks.slice(0, 6)} />
    </>
  );
}

function RecentMemberTasks({ tasks }) {
  return (
    <Panel title="Recent Task">
      {!tasks.length ? (
        <div className="empty">No tasks found.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Project</th>
              <th>Deadline</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Presentation Meet</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td><strong>{task.taskName}</strong><span>{task.description}</span></td>
                <td>{task.project.name}</td>
                <td>{task.deadline}</td>
                <td><span className="badge">{task.statusLabel}</span></td>
                <td>{task.progress}%</td>
                <td>{task.googleMeetLink ? <a href={task.googleMeetLink} target="_blank" rel="noreferrer">Join Meet</a> : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function ManageUsersSection({ data, busy, api, mutate }) {
  return (
    <>
      <CreateUserForm busy={busy} mutate={mutate} api={api} />
      <UsersTable data={data} busy={busy} api={api} mutate={mutate} />
    </>
  );
}

function CreateUserForm({ busy, mutate, api }) {
  const [values, setValues] = useState({ username: '', email: '', role: 'member', password: '', phone_number: '', dob: '', age: '', salary: '', address: '' });
  return (
    <Panel title="Add User">
      <form className="formGrid" onSubmit={(event) => {
        event.preventDefault();
        mutate(
          () => api('/users/', { method: 'POST', body: JSON.stringify(values) }),
          (result) => {
            if (result.passwordEmailSent) return 'User created and credentials emailed.';
            return `User created, but credentials email was not sent: ${result.passwordEmailError}`;
          },
        );
      }}>
        <input required placeholder="Username" value={values.username} onChange={(event) => setValues({ ...values, username: event.target.value })} />
        <input required placeholder="Email" type="email" value={values.email} onChange={(event) => setValues({ ...values, email: event.target.value })} />
        <select value={values.role} onChange={(event) => setValues({ ...values, role: event.target.value })}>
          <option value="manager">Manager</option>
          <option value="tl">Team Leader</option>
          <option value="member">Team Member</option>
        </select>
        <input required placeholder="Password" type="password" value={values.password} onChange={(event) => setValues({ ...values, password: event.target.value })} />
        <input placeholder="Phone" value={values.phone_number} onChange={(event) => setValues({ ...values, phone_number: event.target.value })} />
        <input type="date" value={values.dob} onChange={(event) => setValues({ ...values, dob: event.target.value })} />
        <input placeholder="Age" type="number" value={values.age} onChange={(event) => setValues({ ...values, age: event.target.value })} />
        <input placeholder="Salary" type="number" value={values.salary} onChange={(event) => setValues({ ...values, salary: event.target.value })} />
        <textarea placeholder="Address" value={values.address} onChange={(event) => setValues({ ...values, address: event.target.value })} />
        <button className="primaryButton" disabled={busy}>Create user</button>
      </form>
    </Panel>
  );
}

function UsersTable({ data, busy, api, mutate }) {
  const [editingId, setEditingId] = useState(null);
  const [values, setValues] = useState({});

  function startEdit(user) {
    setEditingId(user.id);
    setValues({
      username: user.username,
      email: user.email || '',
      role: user.role || 'member',
      phone_number: user.phoneNumber || '',
      dob: user.dob || '',
      age: user.age || '',
      salary: user.salary || '',
      address: user.address || '',
      password: '',
    });
  }

  return (
    <Panel title="Users">
      <table>
        <thead><tr><th>User</th><th>Role</th><th>Phone</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>
          {data.users.map((item) => (
            <tr key={item.id}>
              {editingId === item.id ? (
                <>
                  <td>
                    <div className="editGrid">
                      <input required placeholder="Username" value={values.username} onChange={(event) => setValues({ ...values, username: event.target.value })} />
                      <input required placeholder="Email" type="email" value={values.email} onChange={(event) => setValues({ ...values, email: event.target.value })} />
                      <input placeholder="New password" type="password" value={values.password} onChange={(event) => setValues({ ...values, password: event.target.value })} />
                    </div>
                  </td>
                  <td>
                    <select value={values.role} onChange={(event) => setValues({ ...values, role: event.target.value })}>
                      <option value="manager">Manager</option>
                      <option value="tl">Team Leader</option>
                      <option value="member">Team Member</option>
                    </select>
                  </td>
                  <td><input placeholder="Phone" value={values.phone_number} onChange={(event) => setValues({ ...values, phone_number: event.target.value })} /></td>
                  <td><span className={item.isActive ? 'badge success' : 'badge muted'}>{item.isActive ? 'Active' : 'Inactive'}</span></td>
                  <td>
                    <div className="actions">
                      <button className="primaryButton" disabled={busy} onClick={() => {
                        mutate(
                          () => api(`/users/${item.id}/`, { method: 'POST', body: JSON.stringify(values) }),
                          (result) => {
                            if (!values.password) return 'User updated.';
                            if (result.passwordEmailSent) return 'User updated and new password emailed.';
                            return `User updated, but password email was not sent: ${result.passwordEmailError}`;
                          },
                        );
                        setEditingId(null);
                      }}>Save</button>
                      <button disabled={busy} onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                  </td>
                </>
              ) : (
                <>
                  <td><strong>{item.username}</strong><span>{item.email || 'No email'}</span></td>
                  <td><span className="badge">{item.roleLabel}</span></td>
                  <td>{item.phoneNumber || '-'}</td>
                  <td><span className={item.isActive ? 'badge success' : 'badge muted'}>{item.isActive ? 'Active' : 'Inactive'}</span></td>
                  <td>
                    <div className="actions">
                      <button disabled={busy} onClick={() => startEdit(item)}>Edit</button>
                      {item.id === data.user.id ? (
                        <span>Current user</span>
                      ) : (
                        <button className="dangerButton" disabled={busy} onClick={() => mutate(() => api(`/users/${item.id}/`, { method: 'DELETE' }), 'User deleted.')}>Delete</button>
                      )}
                    </div>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function CreateGroupSection({ data, busy, mutate, api }) {
  const [editingGroup, setEditingGroup] = useState(null);
  return (
    <>
      <CreateGroupForm data={data} busy={busy} mutate={mutate} api={api} editingGroup={editingGroup} clearEditing={() => setEditingGroup(null)} />
      <GroupsTable data={data} busy={busy} api={api} mutate={mutate} onEdit={setEditingGroup} />
    </>
  );
}

function CreateGroupForm({ data, busy, mutate, api, editingGroup, clearEditing }) {
  const [values, setValues] = useState({ name: '', manager: '', teamLeaders: [], memberAssignments: [] });
  useEffect(() => {
    if (!editingGroup) return;
    setValues({
      name: editingGroup.name,
      manager: String(editingGroup.manager.id),
      teamLeaders: editingGroup.teamLeaders.map((leader) => String(leader.id)),
      memberAssignments: editingGroup.teamLeaders.map((leader) => ({
        teamLeader: String(leader.id),
        members: editingGroup.members
          .filter((item) => item.teamLeader.id === leader.id)
          .map((item) => String(item.member.id)),
      })),
    });
  }, [editingGroup]);

  const editingLeaderIds = editingGroup ? editingGroup.teamLeaders.map((leader) => String(leader.id)) : [];
  const groupTeamLeaders = data.options.groupTeamLeaders || data.options.teamLeaders;
  const availableTeamLeaders = [
    ...groupTeamLeaders,
    ...data.options.teamLeaders.filter((item) => editingLeaderIds.includes(String(item.id))),
  ].filter((item, index, leaders) => leaders.findIndex((leader) => leader.id === item.id) === index);
  const selectedLeaders = availableTeamLeaders.filter((leader) => values.teamLeaders.includes(String(leader.id)));
  const groupMembers = data.options.groupMembers || data.options.members;
  const editingMemberIds = editingGroup ? editingGroup.members.map((item) => String(item.member.id)) : [];
  const availableMembers = [
    ...groupMembers,
    ...data.options.members.filter((item) => editingMemberIds.includes(String(item.id))),
  ].filter((item, index, members) => members.findIndex((member) => member.id === item.id) === index);
  const selectedMemberIds = values.memberAssignments.flatMap((assignment) => assignment.members || []);
  const title = editingGroup ? `Edit Group: ${editingGroup.name}` : 'Create Group';
  return (
    <Panel title={title}>
      <form className="formGrid" onSubmit={(event) => {
        event.preventDefault();
        if (editingGroup) {
          mutate(() => api(`/groups/${editingGroup.id}/`, { method: 'POST', body: JSON.stringify(values) }), 'Group updated.');
          setValues({ name: '', manager: '', teamLeaders: [], memberAssignments: [] });
          clearEditing();
          return;
        }
        mutate(() => api('/groups/', { method: 'POST', body: JSON.stringify(values) }), 'Group created.');
        setValues({ name: '', manager: '', teamLeaders: [], memberAssignments: [] });
      }}>
        <label className="stacked">
          Group name
          <input required placeholder="Group name" value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} />
        </label>
        <label className="stacked">
          Manager
          <select required value={values.manager} onChange={(event) => setValues({ ...values, manager: event.target.value })}>
            <option value="">Manager</option>
            {data.options.managers.map((item) => <option key={item.id} value={item.id}>{item.username}</option>)}
          </select>
        </label>
        <label className="stacked">
          Team leader
          <select multiple value={values.teamLeaders} onChange={(event) => {
            const teamLeaders = Array.from(event.target.selectedOptions).map((option) => option.value);
            setValues({
              ...values,
              teamLeaders,
              memberAssignments: teamLeaders.map((id) => (
                values.memberAssignments.find((item) => String(item.teamLeader) === String(id)) || { teamLeader: id, members: [] }
              )),
            });
          }}>
            {availableTeamLeaders.map((item) => <option key={item.id} value={item.id}>{item.username}</option>)}
          </select>
        </label>
        {selectedLeaders.map((leader) => (
          <label className="stacked" key={leader.id}>
            Team members for {leader.username}
            {(() => {
              const currentMembers = values.memberAssignments.find((item) => String(item.teamLeader) === String(leader.id))?.members || [];
              const memberOptions = availableMembers.filter((item) => (
                currentMembers.includes(String(item.id)) || !selectedMemberIds.includes(String(item.id))
              ));
              return (
            <select multiple onChange={(event) => {
              const members = Array.from(event.target.selectedOptions).map((option) => option.value);
              setValues({
                ...values,
                memberAssignments: values.memberAssignments.map((item) => (
                  String(item.teamLeader) === String(leader.id) ? { ...item, members } : item
                )),
              });
            }} value={values.memberAssignments.find((item) => String(item.teamLeader) === String(leader.id))?.members || []}>
              {memberOptions.map((item) => <option key={item.id} value={item.id}>{item.username}</option>)}
            </select>
              );
            })()}
          </label>
        ))}
        <div className="actions">
          <button className="primaryButton" disabled={busy}>{editingGroup ? 'Save group' : 'Create group'}</button>
          {editingGroup && <button type="button" disabled={busy} onClick={() => {
            setValues({ name: '', manager: '', teamLeaders: [], memberAssignments: [] });
            clearEditing();
          }}>Cancel edit</button>}
        </div>
      </form>
    </Panel>
  );
}

function GroupsTable({ data, busy, api, mutate, onEdit }) {
  return (
    <Panel title="Group Details">
      <table>
        <thead><tr><th>Group</th><th>Manager</th><th>Team Leaders</th><th>Team Members</th><th>Action</th></tr></thead>
        <tbody>
          {data.groups.map((group) => (
            <tr key={group.id}>
              <td><strong>{group.name}</strong><span>{new Date(group.createdAt).toLocaleDateString()}</span></td>
              <td>{group.manager.username}</td>
              <td>{group.teamLeaders.length ? group.teamLeaders.map((leader) => <span className="badge" key={leader.id}>{leader.username}</span>) : '-'}</td>
              <td>
                {group.members.length ? group.members.map((item) => (
                  <div className="miniTask" key={item.id}>
                    <strong>{item.member.username}</strong>
                    <span>under {item.teamLeader.username}</span>
                  </div>
                )) : '-'}
              </td>
              <td>
                <div className="actions">
                  <button disabled={busy} onClick={() => onEdit(group)}>Edit</button>
                  <button className="dangerButton" disabled={busy} onClick={() => mutate(() => api(`/groups/${group.id}/`, { method: 'DELETE' }), 'Group deleted.')}>Delete</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function ProjectsView({ data, busy, api, mutate, user }) {
  const [values, setValues] = useState({ name: '', description: '', assignedTl: '', deadline: '' });
  return (
    <>
      {(user.role === 'manager' || user.isSuperuser) && (
        <Panel title="Create Project">
          <form className="formGrid inline" onSubmit={(event) => {
            event.preventDefault();
            mutate(() => api('/projects/', { method: 'POST', body: JSON.stringify(values) }), 'Project created.');
          }}>
            <input required placeholder="Project name" value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} />
            <input required type="date" value={values.deadline} onChange={(event) => setValues({ ...values, deadline: event.target.value })} />
            <select value={values.assignedTl} onChange={(event) => setValues({ ...values, assignedTl: event.target.value })}>
              <option value="">Team leader</option>
              {data.options.teamLeaders.map((item) => <option key={item.id} value={item.id}>{item.username}</option>)}
            </select>
            <textarea required placeholder="Description" value={values.description} onChange={(event) => setValues({ ...values, description: event.target.value })} />
            <button className="primaryButton" disabled={busy}>Create project</button>
          </form>
        </Panel>
      )}
      <Panel title="Projects">
        <table>
          <thead><tr><th>Project</th><th>TL</th><th>Deadline</th><th>Status</th></tr></thead>
          <tbody>
            {data.projects.map((project) => (
              <tr key={project.id}>
                <td><strong>{project.name}</strong><span>{project.description}</span></td>
                <td>{project.assignedTl?.username || '-'}</td>
                <td>{project.deadline}</td>
                <td>
                  <select value={project.status} onChange={(event) => mutate(
                    () => api(`/projects/${project.id}/status/`, { method: 'POST', body: JSON.stringify({ status: event.target.value }) }),
                    'Project status updated.',
                  )}>
                    {data.options.projectStatuses.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

function ReportsView({ data }) {
  return (
    <Panel title="Project Report">
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>Team Leader</th>
            <th>Status</th>
            <th>Deadline</th>
            <th>Tasks</th>
          </tr>
        </thead>
        <tbody>
          {data.projects.map((project) => {
            const tasks = data.tasks.filter((task) => task.project.id === project.id);
            const done = tasks.filter((task) => task.status === 'completed').length;
            const projectProgress = tasks.length ? Math.round(tasks.reduce((sum, task) => sum + task.progress, 0) / tasks.length) : 0;
            return (
              <tr key={project.id}>
                <td>
                  <strong>{project.name}</strong>
                  <span>{project.description}</span>
                </td>
                <td>{project.assignedTl?.username || '-'}</td>
                <td><span className="badge">{project.statusLabel}</span></td>
                <td>{project.deadline}</td>
                <td>
                  <div className="reportSummary">
                    <strong>{done}/{tasks.length} completed</strong>
                    <div className="progressBar"><span style={{ width: `${projectProgress}%` }} /></div>
                    <span>{projectProgress}% average progress</span>
                  </div>
                  {tasks.length ? tasks.map((task) => (
                    <div className="miniTask" key={task.id}>
                      <strong>{task.taskName}</strong>
                      <span>{task.assignedMember.username} - {task.progress}% - {task.statusLabel}</span>
                    </div>
                  )) : <span>No tasks created</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

function TasksView({ data, busy, api, mutate, user }) {
  const [values, setValues] = useState({ taskName: '', description: '', project: '', assignedMember: '', deadline: '' });
  const reviewTasks = data.tasks.filter((task) => task.status === 'submitted');
  const taskMembers = data.options.taskMembers || data.options.members;
  const canCreateTask = data.projects.length > 0 && taskMembers.length > 0;
  return (
    <>
      {(user.role === 'tl' || user.isSuperuser) && reviewTasks.length > 0 && (
        <div className="notice">
          <strong>Submitted work waiting for review:</strong> {reviewTasks.map((task) => task.taskName).join(', ')}
        </div>
      )}
      {(user.role === 'tl' || user.isStaff || user.isSuperuser) && (
        <Panel title="Create Task">
          {!canCreateTask && (
            <div className="notice danger">
              {data.projects.length === 0
                ? 'No project is assigned to this team leader.'
                : 'No team members are allocated to this team leader.'}
            </div>
          )}
          <form className="formGrid inline" onSubmit={(event) => {
            event.preventDefault();
            mutate(() => api('/tasks/', { method: 'POST', body: JSON.stringify(values) }), 'Task created.');
          }}>
            <input required placeholder="Task name" value={values.taskName} onChange={(event) => setValues({ ...values, taskName: event.target.value })} />
            <select required value={values.project} onChange={(event) => setValues({ ...values, project: event.target.value })}>
              <option value="">Project</option>
              {data.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <select required value={values.assignedMember} onChange={(event) => setValues({ ...values, assignedMember: event.target.value })}>
              <option value="">Member</option>
              {taskMembers.map((item) => <option key={item.id} value={item.id}>{item.username}</option>)}
            </select>
            <input required type="date" value={values.deadline} onChange={(event) => setValues({ ...values, deadline: event.target.value })} />
            <textarea required placeholder="Description" value={values.description} onChange={(event) => setValues({ ...values, description: event.target.value })} />
            <button className="primaryButton" disabled={busy || !canCreateTask}>Create task</button>
          </form>
        </Panel>
      )}
      <Panel title="Tasks">
        <TaskTable tasks={data.tasks} api={api} mutate={mutate} showActions />
      </Panel>
    </>
  );
}

function MemberTasks({ data, busy, api, mutate, readOnly = false }) {
  if (!data.tasks.length) {
    return <Panel title={readOnly ? 'Team Member Tasks' : 'My Tasks'}><div className="empty">No tasks found.</div></Panel>;
  }

  return (
    <Panel title={readOnly ? 'Team Member Tasks' : 'My Tasks'}>
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Project</th>
            <th>Deadline</th>
            <th>Status</th>
            <th>Progress</th>
            <th>Presentation Meet</th>
            <th>Update</th>
            <th>Submit Work</th>
            <th>History</th>
          </tr>
        </thead>
        <tbody>
          {data.tasks.map((task) => (
            <MemberTaskRow key={task.id} task={task} busy={busy} api={api} mutate={mutate} readOnly={readOnly} />
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function MemberTaskRow({ task, busy, api, mutate, readOnly = false }) {
  const [progress, setProgress] = useState(task.progress);
  const [comment, setComment] = useState('');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState(null);
  return (
    <tr>
      <td><strong>{task.taskName}</strong><span>{task.description}</span></td>
      <td>{task.project.name}</td>
      <td>{task.deadline}</td>
      <td><span className="badge">{task.statusLabel}</span></td>
      <td>
        <div className="reportSummary">
          <strong>{task.progress}%</strong>
          <div className="progressBar"><span style={{ width: `${task.progress}%` }} /></div>
        </div>
      </td>
      <td>
        {task.googleMeetLink ? <a href={task.googleMeetLink} target="_blank" rel="noreferrer">Join Meet</a> : '-'}
      </td>
      <td>
        {!readOnly ? (
          <form className="tableForm" onSubmit={(event) => {
            event.preventDefault();
            mutate(() => api(`/tasks/${task.id}/progress/`, { method: 'POST', body: JSON.stringify({ progress, comment }) }), 'Progress updated.');
          }}>
            <input type="number" min="0" max="100" value={progress} onChange={(event) => setProgress(event.target.value)} />
            <input placeholder="Progress comment" value={comment} onChange={(event) => setComment(event.target.value)} />
            <button disabled={busy}>Update</button>
          </form>
        ) : '-'}
      </td>
      <td>
        {!readOnly ? (
          <form className="tableForm" onSubmit={(event) => {
            event.preventDefault();
            const body = new FormData();
            Array.from(files || []).forEach((file) => body.append('workFiles', file));
            body.append('note', note);
            mutate(() => api(`/tasks/${task.id}/submit/`, { method: 'POST', body }), 'Work submitted.');
          }}>
            <input type="file" multiple onChange={(event) => setFiles(event.target.files)} />
            <input placeholder="Submission note" value={note} onChange={(event) => setNote(event.target.value)} />
            <button className="primaryButton" disabled={busy}>Submit work</button>
          </form>
        ) : '-'}
      </td>
      <td><TaskHistory task={task} api={api} /></td>
    </tr>
  );
}

function TaskHistory({ task, api }) {
  const [open, setOpen] = useState(false);
  const [updates, setUpdates] = useState(null);
  const [error, setError] = useState('');

  async function toggleHistory() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (updates) return;
    try {
      const body = await api(`/tasks/${task.id}/history/`);
      setUpdates(body.updates);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="historyBox">
      <button type="button" onClick={toggleHistory}>{open ? 'Hide history' : 'History'}</button>
      {open && (
        <div className="historyList">
          {error && <div className="notice danger">{error}</div>}
          {!updates && !error && <span>Loading history...</span>}
          {updates && updates.length === 0 && <span>No progress updates yet.</span>}
          {updates && updates.map((update) => (
            <div className="historyItem" key={update.id}>
              <strong>{update.progress}%</strong>
              <span>{update.comment || 'No comment'}</span>
              <small>{new Date(update.updatedAt).toLocaleString()}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskTable({ tasks, api, mutate, compact = false, showActions = false }) {
  const [meetLinks, setMeetLinks] = useState({});
  if (!tasks.length) return <div className="empty">No tasks found.</div>;
  return (
    <table>
      <thead><tr><th>Task</th><th>Project</th><th>Member</th><th>Status</th><th>Progress</th>{!compact && <th>Files</th>}{showActions && <th>Action</th>}</tr></thead>
      <tbody>
        {tasks.map((task) => (
          <tr key={task.id}>
            <td><strong>{task.taskName}</strong><span>{task.deadline}</span></td>
            <td>{task.project.name}</td>
            <td>{task.assignedMember.username}</td>
            <td><span className="badge">{task.statusLabel}</span></td>
            <td>{task.progress}%</td>
            {!compact && (
              <td>{task.submissions.length ? task.submissions.map((item) => <a key={item.id} href={item.fileUrl} target="_blank" rel="noreferrer">{item.fileName}</a>) : '-'}</td>
            )}
            {showActions && (
              <td>
                {api && <TaskHistory task={task} api={api} />}
                {task.status === 'submitted' && (
                  <div className="actions">
                    <input placeholder="https://meet.google.com/..." value={meetLinks[task.id] || task.googleMeetLink || ''} onChange={(event) => setMeetLinks({ ...meetLinks, [task.id]: event.target.value })} />
                    <button onClick={() => mutate(
                      () => api(`/tasks/${task.id}/meet/`, { method: 'POST', body: JSON.stringify({ google_meet_link: meetLinks[task.id] || task.googleMeetLink }) }),
                      (result) => {
                        if (result.meetEmailSent) return 'Meet link saved and emailed.';
                        return `Meet link saved, but email was not sent: ${result.meetEmailError}`;
                      },
                    )}>Send Meet</button>
                    <button className="primaryButton" onClick={() => mutate(() => api(`/tasks/${task.id}/approve/`, { method: 'POST' }), 'Task approved.')}>Approve</button>
                  </div>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Stat({ label, value }) {
  return <div className="statCard"><span>{label}</span><strong>{value}</strong></div>;
}

function Panel({ title, children }) {
  return <section className="panel"><div className="panelHead"><h2>{title}</h2></div><div>{children}</div></section>;
}

createRoot(document.getElementById('root')).render(<App />);
