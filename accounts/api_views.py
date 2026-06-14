import json

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model, login, logout
from django.contrib.auth.decorators import login_required
from django.core.mail import send_mail
from django.db import IntegrityError
from django.db import transaction
from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.http import require_http_methods

from accounts.forms import WebAdminUserCreationForm
from accounts.models import TeamGroup, TeamGroupLeader, TeamGroupMember
from projects.models import Project
from tasks.forms import MeetLinkForm
from tasks.models import ProgressUpdate, Task
from tasks.views import update_project_status


def payload(request):
    if request.content_type and 'application/json' in request.content_type:
        try:
            return json.loads(request.body.decode('utf-8') or '{}')
        except json.JSONDecodeError:
            return {}
    return request.POST


def role_label(user):
    if user.is_staff or user.is_superuser:
        return 'Admin'
    return user.get_role_display() or 'User'


def user_json(user):
    return {
        'id': user.id,
        'username': user.username,
        'email': user.email,
        'role': user.role,
        'roleLabel': role_label(user),
        'phoneNumber': user.phone_number,
        'dob': user.dob.isoformat() if user.dob else '',
        'age': user.age,
        'salary': str(user.salary) if user.salary is not None else '',
        'address': user.address,
        'isActive': user.is_active,
        'isStaff': user.is_staff,
        'isSuperuser': user.is_superuser,
    }


def project_json(project):
    return {
        'id': project.id,
        'name': project.name,
        'description': project.description,
        'assignedTl': user_json(project.assigned_tl) if project.assigned_tl else None,
        'deadline': project.deadline.isoformat(),
        'status': project.status,
        'statusLabel': project.get_status_display(),
    }


def submission_json(submission):
    return {
        'id': submission.id,
        'fileName': submission.work_file.name,
        'fileUrl': submission.work_file.url if submission.work_file else '',
        'note': submission.note,
        'uploadedAt': submission.uploaded_at.isoformat(),
        'submittedBy': user_json(submission.submitted_by),
    }


def task_json(task):
    return {
        'id': task.id,
        'taskName': task.task_name,
        'description': task.description,
        'project': project_json(task.project),
        'assignedMember': user_json(task.assigned_member),
        'deadline': task.deadline.isoformat(),
        'progress': task.progress,
        'status': task.status,
        'statusLabel': task.get_status_display(),
        'googleMeetLink': task.google_meet_link,
        'presentationRequestedAt': (
            task.presentation_requested_at.isoformat()
            if task.presentation_requested_at
            else ''
        ),
        'submissions': [submission_json(item) for item in task.submissions.all()],
    }


def task_member_options_for(user):
    User = get_user_model()
    if admin_required(user):
        return User.objects.filter(role='member').order_by('username')
    if user.role == 'tl':
        member_ids = TeamGroupMember.objects.filter(
            team_leader=user,
        ).values_list('member_id', flat=True)
        return User.objects.filter(id__in=member_ids).order_by('username')
    return User.objects.filter(role='member').order_by('username')


def group_json(group):
    leaders = [item.team_leader for item in group.leader_assignments.all()]
    members = [
        {
            'id': item.id,
            'teamLeader': user_json(item.team_leader),
            'member': user_json(item.member),
        }
        for item in group.member_assignments.all()
    ]
    return {
        'id': group.id,
        'name': group.name,
        'manager': user_json(group.manager),
        'teamLeaders': [user_json(item) for item in leaders],
        'members': members,
        'createdAt': group.created_at.isoformat(),
    }


def current_user_payload(request):
    if not request.user.is_authenticated:
        return None
    return user_json(request.user)


def admin_required(user):
    return user.is_staff or user.is_superuser


def json_error(message, status=400, errors=None):
    body = {'error': message}
    if errors:
        body['errors'] = errors
    return JsonResponse(body, status=status)


def normalize_user_data(data):
    cleaned = data.copy()
    for field in ['phone_number', 'dob', 'age', 'salary', 'address']:
        if cleaned.get(field) == '':
            cleaned[field] = None
    return cleaned


def send_password_email(user, raw_password, subject):
    if not user.email:
        return False, 'User has no email address.'
    if not settings.EMAIL_HOST_USER or not settings.EMAIL_HOST_PASSWORD:
        return False, 'Email settings are not configured.'

    try:
        send_mail(
            subject=subject,
            message=(
                f'Hello {user.username},\n\n'
                f'Username: {user.username}\n'
                f'Password: {raw_password}\n'
            ),
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[user.email],
            fail_silently=False,
        )
    except Exception as error:
        return False, str(error)

    return True, ''


@require_http_methods(['GET'])
def session_view(request):
    return JsonResponse({
        'csrfToken': get_token(request),
        'user': current_user_payload(request),
    })


@require_http_methods(['POST'])
def login_view(request):
    data = payload(request)
    role = data.get('role')
    user = authenticate(
        request,
        username=data.get('username'),
        password=data.get('password'),
    )

    if not user:
        return json_error('Invalid username or password.', status=401)

    if role == 'admin':
        if not admin_required(user):
            return json_error('This user does not have admin access.', status=403)
    elif user.role != role:
        return json_error('Selected role does not match user role.', status=403)

    login(request, user)
    return JsonResponse({'user': user_json(user), 'csrfToken': get_token(request)})


@require_http_methods(['POST'])
def logout_view(request):
    logout(request)
    return JsonResponse({'ok': True})


@login_required
@require_http_methods(['GET'])
def bootstrap_view(request):
    User = get_user_model()
    users = User.objects.order_by('role', 'username')
    allocated_leader_ids = TeamGroupLeader.objects.values_list('team_leader_id', flat=True)
    allocated_member_ids = TeamGroupMember.objects.values_list('member_id', flat=True)
    projects = Project.objects.select_related('assigned_tl').all()
    tasks = Task.objects.select_related(
        'project',
        'project__assigned_tl',
        'assigned_member',
    ).prefetch_related('submissions', 'submissions__submitted_by')

    if request.user.role == 'tl':
        projects = projects.filter(assigned_tl=request.user)
        tasks = tasks.filter(project__assigned_tl=request.user)
    elif request.user.role == 'member':
        tasks = tasks.filter(assigned_member=request.user)

    groups = TeamGroup.objects.select_related('manager').prefetch_related(
        'leader_assignments__team_leader',
        'member_assignments__team_leader',
        'member_assignments__member',
    ).order_by('name')

    return JsonResponse({
        'user': user_json(request.user),
        'stats': {
            'totalUsers': users.count(),
            'managers': users.filter(role='manager').count(),
            'teamLeaders': users.filter(role='tl').count(),
            'members': users.filter(role='member').count(),
            'totalProjects': projects.count(),
            'completedProjects': projects.filter(status='completed').count(),
            'pendingProjects': projects.filter(status='pending').count(),
            'totalTasks': tasks.count(),
            'completedTasks': tasks.filter(status='completed').count(),
            'submittedTasks': tasks.filter(status='submitted').count(),
        },
        'users': [user_json(item) for item in users],
        'groups': [group_json(item) for item in groups],
        'projects': [project_json(item) for item in projects.order_by('deadline')],
        'tasks': [task_json(item) for item in tasks.order_by('deadline')],
        'options': {
            'managers': [user_json(item) for item in users.filter(role='manager')],
            'teamLeaders': [user_json(item) for item in users.filter(role='tl')],
            'groupTeamLeaders': [
                user_json(item)
                for item in users.filter(role='tl').exclude(id__in=allocated_leader_ids)
            ],
            'members': [user_json(item) for item in users.filter(role='member')],
            'taskMembers': [user_json(item) for item in task_member_options_for(request.user)],
            'groupMembers': [
                user_json(item)
                for item in users.filter(role='member').exclude(id__in=allocated_member_ids)
            ],
            'projectStatuses': [
                {'value': value, 'label': label}
                for value, label in Project.STATUS_CHOICES
            ],
            'taskStatuses': [
                {'value': value, 'label': label}
                for value, label in Task.STATUS_CHOICES
            ],
        },
    })


@login_required
@require_http_methods(['POST'])
def users_view(request):
    if not admin_required(request.user):
        return json_error('Admin access is required.', status=403)

    data = normalize_user_data(payload(request))
    if 'password' in data and 'password1' not in data:
        data['password1'] = data['password']
        data['password2'] = data['password']

    form = WebAdminUserCreationForm(data)
    if not form.is_valid():
        return json_error('User could not be created.', errors=form.errors, status=422)

    raw_password = form.cleaned_data['password1']
    try:
        user = form.save()
    except IntegrityError:
        return json_error('Username or phone number is already used.', status=422)
    except Exception as error:
        return json_error(f'User could not be saved: {error}', status=500)
    email_sent, email_error = send_password_email(
        user,
        raw_password,
        'Your task management account has been created',
    )

    return JsonResponse({
        'user': user_json(user),
        'passwordEmailSent': email_sent,
        'passwordEmailError': email_error,
    }, status=201)


@login_required
@require_http_methods(['DELETE', 'PATCH', 'POST'])
def user_detail_view(request, user_id):
    if not admin_required(request.user):
        return json_error('Admin access is required.', status=403)
    user = get_object_or_404(get_user_model(), id=user_id)

    if request.method == 'DELETE':
        if user_id == request.user.id:
            return json_error('You cannot delete your own account.', status=400)
        user.delete()
        return JsonResponse({'ok': True})

    data = normalize_user_data(payload(request))
    for field in ['username', 'email', 'role', 'phone_number', 'dob', 'age', 'salary', 'address']:
        if field in data:
            value = data.get(field)
            setattr(user, field, value)

    raw_password = data.get('password')
    if raw_password:
        user.set_password(raw_password)

    try:
        user.save()
    except IntegrityError:
        return json_error('Username or phone number is already used.', status=422)

    email_sent = None
    email_error = ''
    if raw_password:
        email_sent, email_error = send_password_email(
            user,
            raw_password,
            'Your task management password has been updated',
        )

    return JsonResponse({
        'user': user_json(user),
        'passwordEmailSent': email_sent,
        'passwordEmailError': email_error,
    })


@login_required
@require_http_methods(['POST'])
def groups_view(request):
    if not admin_required(request.user):
        return json_error('Admin access is required.', status=403)

    data = payload(request)
    manager = get_object_or_404(get_user_model(), id=data.get('manager'), role='manager')
    leader_ids = [int(item) for item in data.get('teamLeaders', [])]
    assignments = data.get('memberAssignments', [])

    if not data.get('name') or not leader_ids:
        return json_error('Group name and at least one team leader are required.')
    if TeamGroupLeader.objects.filter(team_leader_id__in=leader_ids).exists():
        return json_error('One or more team leaders are already allocated to another group.')

    allocated_members = []
    for assignment in assignments:
        allocated_members.extend(int(item) for item in assignment.get('members', []))
    if len(allocated_members) != len(set(allocated_members)):
        return json_error('A member can be assigned only once in a group.')
    if TeamGroupMember.objects.filter(member_id__in=allocated_members).exists():
        return json_error('One or more members are already allocated to another group.')

    with transaction.atomic():
        group = TeamGroup.objects.create(name=data['name'], manager=manager)
        for leader_id in leader_ids:
            leader = get_object_or_404(get_user_model(), id=leader_id, role='tl')
            TeamGroupLeader.objects.create(group=group, team_leader=leader)
        for assignment in assignments:
            leader = get_object_or_404(get_user_model(), id=assignment.get('teamLeader'), role='tl')
            for member_id in assignment.get('members', []):
                member = get_object_or_404(get_user_model(), id=member_id, role='member')
                TeamGroupMember.objects.create(
                    group=group,
                    team_leader=leader,
                    member=member,
                )

    group = TeamGroup.objects.select_related('manager').prefetch_related(
        'leader_assignments__team_leader',
        'member_assignments__team_leader',
        'member_assignments__member',
    ).get(id=group.id)
    return JsonResponse({'group': group_json(group)}, status=201)


@login_required
@require_http_methods(['DELETE', 'PATCH', 'POST'])
def group_detail_view(request, group_id):
    if not admin_required(request.user):
        return json_error('Admin access is required.', status=403)
    group = get_object_or_404(TeamGroup, id=group_id)

    if request.method == 'DELETE':
        group.delete()
        return JsonResponse({'ok': True})

    data = payload(request)
    manager = get_object_or_404(get_user_model(), id=data.get('manager'), role='manager')
    leader_ids = [int(item) for item in data.get('teamLeaders', [])]
    assignments = data.get('memberAssignments', [])

    if not data.get('name') or not leader_ids:
        return json_error('Group name and at least one team leader are required.')
    if TeamGroupLeader.objects.filter(
        team_leader_id__in=leader_ids,
    ).exclude(group=group).exists():
        return json_error('One or more team leaders are already allocated to another group.')

    allocated_members = []
    for assignment in assignments:
        allocated_members.extend(int(item) for item in assignment.get('members', []))
    if len(allocated_members) != len(set(allocated_members)):
        return json_error('A member can be assigned only once in a group.')
    if TeamGroupMember.objects.filter(
        member_id__in=allocated_members,
    ).exclude(group=group).exists():
        return json_error('One or more members are already allocated to another group.')

    with transaction.atomic():
        group.name = data['name']
        group.manager = manager
        group.save(update_fields=['name', 'manager'])
        group.leader_assignments.all().delete()
        group.member_assignments.all().delete()
        for leader_id in leader_ids:
            leader = get_object_or_404(get_user_model(), id=leader_id, role='tl')
            TeamGroupLeader.objects.create(group=group, team_leader=leader)
        for assignment in assignments:
            leader = get_object_or_404(get_user_model(), id=assignment.get('teamLeader'), role='tl')
            for member_id in assignment.get('members', []):
                member = get_object_or_404(get_user_model(), id=member_id, role='member')
                TeamGroupMember.objects.create(
                    group=group,
                    team_leader=leader,
                    member=member,
                )

    group = TeamGroup.objects.select_related('manager').prefetch_related(
        'leader_assignments__team_leader',
        'member_assignments__team_leader',
        'member_assignments__member',
    ).get(id=group.id)
    return JsonResponse({'group': group_json(group)})


@login_required
@require_http_methods(['POST'])
def projects_view(request):
    if request.user.role != 'manager' and not request.user.is_superuser:
        return json_error('Manager access is required.', status=403)

    data = payload(request)
    project = Project.objects.create(
        name=data.get('name', ''),
        description=data.get('description', ''),
        assigned_tl_id=data.get('assignedTl') or None,
        deadline=data.get('deadline'),
    )
    return JsonResponse({'project': project_json(project)}, status=201)


@login_required
@require_http_methods(['PATCH', 'POST'])
def project_status_view(request, project_id):
    project = get_object_or_404(Project, id=project_id)
    if request.user.role == 'tl' and project.assigned_tl_id != request.user.id:
        return json_error('You can update only your assigned projects.', status=403)
    if request.user.role not in ['tl', 'manager'] and not admin_required(request.user):
        return json_error('Project update access is required.', status=403)

    status = payload(request).get('status')
    valid_statuses = [value for value, _ in Project.STATUS_CHOICES]
    if status not in valid_statuses:
        return json_error('Invalid project status.')

    project.status = status
    project.save(update_fields=['status'])
    return JsonResponse({'project': project_json(project)})


@login_required
@require_http_methods(['POST'])
def tasks_view(request):
    if request.user.role != 'tl' and not admin_required(request.user):
        return json_error('Team leader access is required.', status=403)

    data = payload(request)
    projects = Project.objects.filter(id=data.get('project'))
    if not admin_required(request.user):
        projects = projects.filter(assigned_tl=request.user)
    project = get_object_or_404(projects)
    members = task_member_options_for(request.user)
    assigned_member = get_object_or_404(members, id=data.get('assignedMember'))
    task = Task.objects.create(
        task_name=data.get('taskName', ''),
        description=data.get('description', ''),
        project=project,
        assigned_member=assigned_member,
        deadline=data.get('deadline'),
    )
    update_project_status(project)
    return JsonResponse({'task': task_json(task)}, status=201)


@login_required
@require_http_methods(['POST'])
def task_progress_view(request, task_id):
    tasks = Task.objects.filter(id=task_id)
    if not admin_required(request.user):
        tasks = tasks.filter(assigned_member=request.user)
    task = get_object_or_404(tasks)
    data = payload(request)
    progress = int(data.get('progress', 0))
    if progress < 0 or progress > 100:
        return json_error('Progress must be between 0 and 100.')

    ProgressUpdate.objects.create(
        task=task,
        progress=progress,
        comment=data.get('comment', ''),
    )
    task.progress = min(progress, 100)
    if task.progress >= 100:
        task.status = 'submitted'
    elif task.progress > 0:
        task.status = 'in_progress'
    task.save(update_fields=['progress', 'status'])
    update_project_status(task.project)
    return JsonResponse({'task': task_json(task)})


@login_required
@require_http_methods(['POST'])
def task_submit_view(request, task_id):
    tasks = Task.objects.filter(id=task_id)
    if not admin_required(request.user):
        tasks = tasks.filter(assigned_member=request.user)
    task = get_object_or_404(tasks)
    files = request.FILES.getlist('workFiles')
    if not files:
        return json_error('Please choose at least one file.')

    for uploaded_file in files:
        task.submissions.create(
            submitted_by=request.user,
            work_file=uploaded_file,
            note=request.POST.get('note', ''),
        )
    task.status = 'submitted'
    task.progress = 100
    task.save(update_fields=['status', 'progress'])
    update_project_status(task.project)
    return JsonResponse({'task': task_json(task)})


@login_required
@require_http_methods(['POST'])
def task_approve_view(request, task_id):
    tasks = Task.objects.filter(id=task_id, status='submitted')
    if not admin_required(request.user):
        tasks = tasks.filter(project__assigned_tl=request.user)
    task = get_object_or_404(tasks)
    task.status = 'completed'
    task.progress = 100
    task.save(update_fields=['status', 'progress'])
    update_project_status(task.project)
    return JsonResponse({'task': task_json(task)})


@login_required
@require_http_methods(['POST'])
def task_meet_view(request, task_id):
    tasks = Task.objects.filter(id=task_id, status='submitted')
    if not admin_required(request.user):
        tasks = tasks.filter(project__assigned_tl=request.user)
    task = get_object_or_404(tasks)
    form = MeetLinkForm(payload(request), instance=task)
    if not form.is_valid():
        return json_error('Enter a valid Google Meet link.', errors=form.errors, status=422)

    task = form.save(commit=False)
    task.presentation_requested_at = timezone.now()
    task.save(update_fields=['google_meet_link', 'presentation_requested_at'])
    return JsonResponse({'task': task_json(task)})


@login_required
@require_http_methods(['GET'])
def task_history_view(request, task_id):
    task = get_object_or_404(Task, id=task_id)
    if request.user.role == 'member' and task.assigned_member_id != request.user.id:
        return json_error('You can view only your own task history.', status=403)
    if request.user.role == 'tl' and task.project.assigned_tl_id != request.user.id:
        return json_error('You can view only assigned task history.', status=403)

    updates = ProgressUpdate.objects.filter(task=task).order_by('-updated_at')
    return JsonResponse({
        'task': task_json(task),
        'updates': [
            {
                'id': item.id,
                'progress': item.progress,
                'comment': item.comment,
                'updatedAt': item.updated_at.isoformat(),
            }
            for item in updates
        ],
    })
