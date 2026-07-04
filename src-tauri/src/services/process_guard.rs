/// Voicevox 子プロセスを Windows Job Object に割り当てる。
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` を設定することで、
/// 親プロセス（アプリ）終了時に子プロセスも連動して終了する。
/// 失敗してもプロセス起動を中断しないこと — 呼び出し元でログ記録のみ行う。
#[cfg(target_os = "windows")]
pub fn attach_to_job_object(pid: u32) -> Result<(), String> {
    use windows::{
        Win32::{
            Foundation::HANDLE,
            System::{
                JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW,
                    JobObjectExtendedLimitInformation, SetInformationJobObject,
                    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
                Threading::{OpenProcess, PROCESS_ALL_ACCESS},
            },
        },
    };

    unsafe {
        let job: HANDLE = CreateJobObjectW(None, None).map_err(|e| e.to_string())?;

        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
            std::mem::size_of_val(&info) as u32,
        )
        .map_err(|e| e.to_string())?;

        let process: HANDLE = OpenProcess(PROCESS_ALL_ACCESS, false, pid)
            .map_err(|e| e.to_string())?;
        AssignProcessToJobObject(job, process).map_err(|e| e.to_string())?;

        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
pub fn attach_to_job_object(_pid: u32) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_to_job_object_with_own_pid_does_not_panic() {
        let pid = std::process::id();
        // 環境によって成否は異なるが、パニックしないことを確認する
        let _ = attach_to_job_object(pid);
    }
}
