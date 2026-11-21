import { get, mutateRecord, values } from './store.js';

export const studyKey = song => song.track || 'netease-' + song.id;
export const studyRecords = () => values('study', { strict: true });
export const getStudy = track => get('study', track, { strict: true });

export const studyLists = Object.freeze({ learning: '在学', learned: '已学', recent: '最近练唱' });

export function studyListRows(rows, type) {
  return Array.from(rows).filter(song => type === 'recent' ? song.practiced : song.state === type)
    .sort((a, b) => type === 'recent' ? b.practiced - a.practiced : b.marked - a.marked);
}

export function checkpointTime(study) {
  const time = study?.checkpoint;
  return Number.isFinite(time) && time >= 0 ? time : null;
}

function changeStudy(song, update) {
  const track = studyKey(song);
  return mutateRecord('study', track, previous => {
    const row = { id: song.id, track, name: song.name, artist: song.artist || '', cover: song.cover || '',
      duration: song.duration || 0, state: '', practiced: 0, ...previous };
    update(row);
    if (song.cover) row.cover = song.cover;
    return row.state || row.practiced || checkpointTime(row) !== null ? row : null;
  });
}

export function updateStudy(song, change) {
  return changeStudy(song, row => Object.assign(row, change));
}

export async function saveStudyCheckpoint(song, time) {
  if (time !== null && (!Number.isFinite(time) || time < 0)) throw Error('无效的学习进度');
  return changeStudy(song, row => {
    row.checkpoint = time;
    if (time !== null && !row.state) {
      row.state = 'learning';
      row.marked = Date.now();
    }
  });
}
