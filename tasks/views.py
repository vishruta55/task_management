from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.contrib import messages
from django.core.mail import send_mail
from django.conf import settings
from django.utils import timezone
from .models import Task, ProgressUpdate
from .forms import TaskForm, ProgressForm, MeetLinkForm


# CREATE TASK (TL)

def update_project_status(project):
    tasks = project.task_set.all()

    if tasks.exists() and not tasks.exclude(status='completed').exists():
        project.status = 'completed'
    elif tasks.exists():
        project.status = 'in_progress'
    else:
        project.status = 'pending'

    project.save(update_fields=['status'])


@login_required
def create_task(request):

    if request.user.role != 'tl':
        return redirect('login')

    if request.method == "POST":
        form = TaskForm(request.POST, user=request.user)

        if form.is_valid():
            form.save()
            return redirect('task_list')

    else:
        form = TaskForm(user=request.user)

    return render(request, 'tasks/create_task.html', {'form': form})


# TASK LIST

@login_required
def task_list(request):

    if request.user.role == 'tl':
        tasks = Task.objects.filter(
            project__assigned_tl=request.user
        ).prefetch_related('submissions')
    elif request.user.role == 'manager' or request.user.is_superuser:
        tasks = Task.objects.all().prefetch_related('submissions')
    else:
        return redirect('member_tasks')

    return render(request, 'tasks/task_list.html', {'tasks': tasks})



@login_required
def member_tasks(request):

    if request.user.role != 'member':
        return redirect('login')

    tasks = Task.objects.filter(
        assigned_member=request.user
    ).prefetch_related('submissions')

    return render(
        request,
        'tasks/member_tasks.html',
        {'tasks': tasks}
    )


@login_required
def submit_work(request, task_id):

    if request.user.role != 'member':
        return redirect('login')

    task = get_object_or_404(
        Task,
        id=task_id,
        assigned_member=request.user
    )

    if request.method == 'POST':
        uploaded_files = (
            request.FILES.getlist('work_files') +
            request.FILES.getlist('folder_files')
        )
        note = request.POST.get('note', '')

        if uploaded_files:
            for uploaded_file in uploaded_files:
                task.submissions.create(
                    submitted_by=request.user,
                    work_file=uploaded_file,
                    note=note
                )

            task.status = 'submitted'
            task.progress = 100
            task.save(update_fields=['status', 'progress'])
            update_project_status(task.project)

            messages.success(request, 'Your work was shared with your team leader.')
        else:
            messages.error(request, 'Please choose at least one file, image, or folder.')

    return redirect('member_dashboard')


@login_required
def update_progress(request, task_id):

    task = get_object_or_404(
        Task,
        id=task_id,
        assigned_member=request.user
    )

    if request.method == 'POST':

        form = ProgressForm(request.POST)

        if form.is_valid():

            update = form.save(commit=False)

            update.task = task

            update.save()

            task.progress = update.progress

            if update.progress >= 100:
                task.progress = 100
                task.status = 'submitted'

            elif update.progress > 0:
                task.status = 'in_progress'

            task.save()
            update_project_status(task.project)

            return redirect('member_tasks')

    else:

        form = ProgressForm()

    return render(
        request,
        'tasks/update_progress.html',
        {
            'form': form,
            'task': task
        }
    ) 


@login_required
def progress_history(request, task_id):

    if request.user.role == 'member':
        task = get_object_or_404(
            Task,
            id=task_id,
            assigned_member=request.user
        )
    elif request.user.role == 'tl':
        task = get_object_or_404(
            Task,
            id=task_id,
            project__assigned_tl=request.user
        )
    else:
        task = get_object_or_404(
            Task,
            id=task_id
        )

    updates = ProgressUpdate.objects.filter(
        task=task
    ).order_by('-updated_at')

    return render(
        request,
        'tasks/progress_history.html',
        {
            'task': task,
            'updates': updates
        }
    )


@login_required
def approve_task(request, task_id):

    if request.user.role != 'tl':
        return redirect('login')

    task = get_object_or_404(
        Task,
        id=task_id,
        project__assigned_tl=request.user,
        status='submitted'
    )

    if request.method == 'POST':
        task.status = 'completed'
        task.progress = 100
        task.save(update_fields=['status', 'progress'])
        update_project_status(task.project)

    return redirect('task_list')


@login_required
def share_meet_link(request, task_id):

    if request.user.role != 'tl':
        return redirect('login')

    task = get_object_or_404(
        Task,
        id=task_id,
        project__assigned_tl=request.user,
        status='submitted'
    )

    if request.method == 'POST':
        form = MeetLinkForm(request.POST, instance=task)

        if form.is_valid():
            task = form.save(commit=False)
            task.presentation_requested_at = timezone.now()
            task.save(update_fields=[
                'google_meet_link',
                'presentation_requested_at',
            ])

            if task.assigned_member.email:
                try:
                    send_mail(
                        subject=f'Presentation meeting for {task.task_name}',
                        message=(
                            f'Hello {task.assigned_member.username},\n\n'
                            f'Your team leader has shared a Google Meet link '
                            f'for presenting your completed work.\n\n'
                            f'Task: {task.task_name}\n'
                            f'Project: {task.project}\n'
                            f'Meet link: {task.google_meet_link}\n\n'
                            'Please join this meeting and present your work.'
                        ),
                        from_email=settings.DEFAULT_FROM_EMAIL,
                        recipient_list=[task.assigned_member.email],
                        fail_silently=False,
                    )
                    messages.success(request, 'Google Meet link sent to the member.')
                except Exception as error:
                    messages.error(
                        request,
                        f'Meet link saved, but email was not sent: {error}'
                    )
            else:
                messages.warning(
                    request,
                    'Meet link saved, but the assigned member has no email address.'
                )
        else:
            messages.error(request, 'Enter a valid Google Meet link.')

    return redirect('task_list')
