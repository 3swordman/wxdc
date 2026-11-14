CREATE TABLE IF NOT EXISTS submitted_weeks (week_start TEXT PRIMARY KEY);

INSERT OR IGNORE INTO submitted_weeks (week_start)
SELECT substr(message, 11, 10)
FROM jobs
WHERE status = 'success'
  AND ((kind = 'submit' AND message GLOB 'Submitted ????-??-??')
    OR (kind = 'scheduled' AND message GLOB 'Generated ????-??-?? and submitted'));
